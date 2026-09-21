/**
 * Tool installation and per-session gating.
 *
 * These cover the layer the plugin controls: naming, schema normalization, result projection,
 * reference counting across projects, per-session routing, and the refusal a session sees when
 * its project has no index.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { ToolAggregate, createBridgedTool, projectContent, publicToolName, registerSessionGuard, toToolParameters } from '../lib/agent-tools.js'

const EXPLORE_SCHEMA = JSON.parse(readFileSync(new URL('./fixtures/codegraph-explore-schema.json', import.meta.url), 'utf8'))

/** A root tool registry stand-in recording registrations. */
function fakeRegistry() {
  const registered = new Map()
  return {
    registered,
    register(definition) {
      assert.equal(registered.has(definition.name), false, `duplicate registration of ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
}

/** A logger that swallows output. */
const silentLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }

/** A hub stand-in with a fixed tool list and a recording call. */
function fakeHub(overrides = {}) {
  const calls = []
  return {
    calls,
    projectRoot: overrides.projectRoot ?? '/tmp/project-a',
    serverName: 'codegraph',
    toolCallTimeoutMs: 60_000,
    pid: 4242,
    refs: 0,
    retain() { this.refs += 1; return this.refs },
    release() { this.refs -= 1; return this.refs },
    tools: () => overrides.tools ?? [{ name: 'codegraph_explore', description: 'Explore', inputSchema: EXPLORE_SCHEMA }],
    call: async (rawName, args, exec) => {
      calls.push({ rawName, args, exec })
      return overrides.result ?? { content: [{ type: 'text', text: `answer for ${String(args.query)}` }] }
    },
  }
}

test('tool names follow the MCP bridge contract', () => {
  assert.equal(publicToolName('codegraph', 'codegraph_explore'), 'mcp__codegraph__codegraph_explore')
  assert.equal(publicToolName('cg-2', 'explore'), 'mcp__cg-2__explore')
})

test('an over-long tool identity is truncated and hashed, and stays inside the contract', () => {
  const name = publicToolName('codegraph', 'x'.repeat(80))
  assert.ok(name.length <= 64)
  assert.match(name, /^[A-Za-z0-9_-]+$/)
  assert.match(name, /_[0-9a-f]{12}$/)
  // Deterministic: the same identity always produces the same name, because session history
  // and permission rules key on it.
  assert.equal(name, publicToolName('codegraph', 'x'.repeat(80)))
  assert.notEqual(name, publicToolName('codegraph', 'y'.repeat(80)))
})

test('content projection keeps text order and reports unsupported blocks instead of dropping them', () => {
  assert.deepEqual(projectContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 't'), [{ type: 'text', text: 'a\nb' }])
  const mixed = projectContent([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }], 't')
  assert.equal(mixed.length, 2)
  assert.match(mixed[1].text, /dropped a "image" result block/)
  assert.deepEqual(projectContent(undefined, 't'), [])
})

test('the real codegraph explore schema normalizes into the registry DSL', () => {
  const { parameters } = toToolParameters(EXPLORE_SCHEMA)
  assert.deepEqual(Object.keys(parameters), ['query', 'maxFiles', 'projectPath'])
  assert.equal(parameters.query.required, true)
  assert.equal(parameters.query.type, 'string')
  assert.equal(parameters.maxFiles.default, 12)
  assert.equal(parameters.projectPath.required, undefined)
})

test('schema keywords the DSL rejects are dropped, and the tool still registers', () => {
  const dropped = []
  const { parameters } = toToolParameters({
    type: 'object',
    properties: {
      query: { type: 'string', required: true, minLength: 2, format: 'text' },
      mode: { type: 'string', enum: ['fast', 'full'], pattern: '^f' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
      nested: { type: 'object', properties: { deep: { type: 'boolean' } } },
      list: { type: 'array', items: { type: 'string' } },
      either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      anything: {},
    },
  }, (message) => dropped.push(message))
  assert.deepEqual(parameters.mode.enum, ['fast', 'full'])
  assert.equal(parameters.nested.additionalProperties, true)
  assert.deepEqual(parameters.list.items, { type: 'string' })
  assert.equal(parameters.either.oneOf.length, 2)
  assert.equal(parameters.anything.type, 'json')
  assert.ok(dropped.some((entry) => entry.includes('minLength')))
  assert.ok(dropped.some((entry) => entry.includes('pattern')))
  // The point of dropping is registrability: this must not throw. MCP servers state
  // requiredness with a root `required` array (the DSL's property-level `required: true`
  // spelling is not part of the MCP vocabulary), so that is the form exercised here.
  const definition = createBridgedTool({
    publicName: 'mcp__codegraph__codegraph_explore',
    rawName: 'codegraph_explore',
    description: 'Explore',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 2 } }, required: ['query'] },
    call: async () => ({ content: [] }),
    timeoutMs: 1_000,
  })
  assert.deepEqual(definition.parameters.required, ['query'])
})

test('a required array becomes per-property requiredness', () => {
  const { parameters } = toToolParameters({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'number' } },
    required: ['b'],
  })
  assert.equal(parameters.b.required, true)
  assert.equal(parameters.a.required, undefined)
})

test('a registered tool forwards validated arguments and renders the server text', async () => {
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  const hub = fakeHub()
  aggregate.retain(hub)
  assert.deepEqual(aggregate.names(), ['mcp__codegraph__codegraph_explore'])
  const definition = registry.registered.get('mcp__codegraph__codegraph_explore')
  assert.ok(definition)
  const value = await definition.execute({ query: 'beta' }, { signal: undefined })
  assert.deepEqual(hub.calls, [{ rawName: 'codegraph_explore', args: { query: 'beta' }, exec: { signal: undefined } }])
  assert.deepEqual(value, { content: [{ type: 'text', text: 'answer for beta' }] })
  assert.deepEqual(definition.output.render({ query: 'beta' }, value), [{ type: 'text', text: 'answer for beta' }])
})

test('structured content survives the bridge when the server sends it', async () => {
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  const hub = fakeHub({ result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { files: 2 } } })
  aggregate.retain(hub)
  const definition = registry.registered.get('mcp__codegraph__codegraph_explore')
  const value = await definition.execute({ query: 'x' }, {})
  assert.deepEqual(value.structuredContent, { files: 2 })
})

test('an empty result renders the same placeholder the MCP bridge uses', () => {
  const definition = createBridgedTool({
    publicName: 'mcp__codegraph__codegraph_explore',
    rawName: 'codegraph_explore',
    description: '',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    call: async () => ({ content: [] }),
    timeoutMs: 1_000,
  })
  assert.deepEqual(definition.output.render({ query: 'x' }, { content: [] }), [{ type: 'text', text: '[codegraph_explore] (no output)' }])
  assert.equal(definition.description, 'CodeGraph tool "codegraph_explore"')
})

test('release unregisters the tools once the last project lets go, and is idempotent', () => {
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  const twoTools = [
    { name: 'codegraph_explore', description: '', inputSchema: EXPLORE_SCHEMA },
    { name: 'codegraph_node', description: '', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  ]
  const first = aggregate.retain(fakeHub({ projectRoot: '/tmp/one', tools: twoTools }))
  const second = aggregate.retain(fakeHub({ projectRoot: '/tmp/two', tools: twoTools }))
  assert.equal(registry.registered.size, 2, 'one definition per tool NAME, not per project')
  first()
  assert.equal(registry.registered.size, 2, 'the second project keeps them registered')
  first()
  assert.equal(registry.registered.size, 2, 'release is idempotent')
  second()
  assert.equal(registry.registered.size, 0)
})

test('a call routes to the session\'s own project connection', async () => {
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  const hubA = fakeHub({ projectRoot: '/tmp/a' })
  const hubB = fakeHub({ projectRoot: '/tmp/b' })
  aggregate.retain(hubA)
  aggregate.retain(hubB)
  aggregate.setHubs(new Map([['/tmp/a', hubA], ['/tmp/b', hubB]]))
  aggregate.route('session-a', '/tmp/a')
  aggregate.route('session-b', '/tmp/b')
  const definition = registry.registered.get('mcp__codegraph__codegraph_explore')
  await definition.execute({ query: 'from-a' }, { agent: { id: 'session-a' } })
  await definition.execute({ query: 'from-b' }, { agent: { id: 'session-b' } })
  assert.equal(hubA.calls.length, 1)
  assert.equal(hubB.calls.length, 1)
  assert.equal(hubA.calls[0].args.query, 'from-a')
  assert.equal(hubB.calls[0].args.query, 'from-b')
})

test('a failing hub call rejects the tool call instead of reporting a fake success', async () => {
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  const hub = fakeHub()
  hub.call = async () => { throw new Error('boom') }
  aggregate.retain(hub)
  const definition = registry.registered.get('mcp__codegraph__codegraph_explore')
  await assert.rejects(() => definition.execute({ query: 'x' }, {}), /boom/)
})

test('a tool with no server schema still registers with open parameters', () => {
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  aggregate.retain(fakeHub({ tools: [{ name: 'codegraph_status', description: 'Status' }] }))
  assert.deepEqual(aggregate.names(), ['mcp__codegraph__codegraph_status'])
  const definition = registry.registered.get('mcp__codegraph__codegraph_status')
  assert.deepEqual(definition.parameters.properties, {})
})

test('the session guard gates only its own tool names, per calling session', () => {
  const guards = []
  const tools = {
    guard(guard) {
      guards.push(guard)
      return () => guards.splice(guards.indexOf(guard), 1)
    },
  }
  let mounted = new Set(['session-mounted'])
  const remove = registerSessionGuard({
    tools,
    gatedNames: () => ['mcp__codegraph__codegraph_explore'],
    mayCall: (agentId) => agentId !== undefined && mounted.has(agentId),
    reason: (agentId) => `CodeGraph is not enabled for ${String(agentId)}`,
  })
  assert.equal(guards.length, 1)
  const guard = guards[0]
  assert.equal(guard({ name: 'read', agent: { id: 'session-plain' } }), undefined, 'other tools pass through')
  assert.match(String(guard({ name: 'mcp__codegraph__codegraph_explore', agent: { id: 'session-plain' } })), /not enabled for session-plain/)
  assert.equal(guard({ name: 'mcp__codegraph__codegraph_explore', agent: { id: 'session-mounted' } }), undefined, 'a mounted session is allowed')
  assert.match(String(guard({ name: 'mcp__codegraph__codegraph_explore' })), /not enabled/, 'a call with no agent at all is refused')
  mounted = new Set()
  assert.match(String(guard({ name: 'mcp__codegraph__codegraph_explore', agent: { id: 'session-mounted' } })), /not enabled/, 'a released session is refused again')
  remove()
  assert.equal(guards.length, 0, 'the remover lifts the guard')
})
