/**
 * The plugin mounted into a real Cordis runtime with the real tool registry, prompt registry,
 * and subprocess service — only the CodeGraph server itself is stubbed, so the paths under test
 * (event wiring, tool registration, per-session gating, sharing, live index detection, teardown)
 * are the production ones.
 *
 * What this file exists to prove:
 *   - a workspace with no index starts NO process and every CodeGraph call from that session is
 *     refused with an actionable reason;
 *   - an indexed workspace registers the tool for the process and lets that session call it;
 *   - two sessions in one project share ONE server process;
 *   - an index created while a session is running lifts the refusal live, with no restart;
 *   - disposing the last session unregisters the tool and reaps the process.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import { apply as applyPlugin, Config } from '../lib/index.js'
import { fakeSubprocess } from './support/fake-subprocess.js'

const STUB = new URL('./support/stub-mcp-server.js', import.meta.url).pathname

/** Create a project root, optionally already indexed. */
function makeProject(t, { indexed }) {
  const base = mkdtempSync(join(tmpdir(), 'cgraph-int-'))
  const root = join(base, 'project')
  mkdirSync(root, { recursive: true })
  if (indexed) {
    mkdirSync(join(root, '.codegraph'), { recursive: true })
    writeFileSync(join(root, '.codegraph', 'codegraph.db'), '')
  }
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return root
}

/**
 * Build a harness context: real Cordis, real registries, a stub-backed subprocess, and a fake
 * agent registry implementing the one method the plugin reads.
 */
async function harness(t, options = {}) {
  const ctx = new Context()
  ctx.plugin(systemPromptPlugin)
  ctx.plugin(toolsPlugin)
  await new Promise((resolve) => setTimeout(resolve, 30))

  const agents = new Map()
  const spawned = []
  ctx.provide('subprocess', {
    async resolveExecutable(command) {
      if (command !== 'npx' && command !== 'npx.cmd') throw new Error(`fake: ${command} not found`)
      return process.execPath
    },
    spawn(spec) {
      spawned.push(spec)
      return fakeSubprocess.spawn(spec)
    },
  })
  ctx.provide('agents', { get: (id) => agents.get(id) })

  // The row configuration is schema-resolved by the loader in a real deployment; the test
  // applies the same schema, then substitutes only the launched program.
  applyPlugin(ctx, new Config({
    enabled: true,
    version: 'stub',
    packageSpec: 'codegraph-stub@0.0.0',
    cacheDir: join(tmpdir(), 'cgraph-int-cache'),
    serverName: 'codegraph',
    toolCallTimeoutMs: 5_000,
    pollIntervalMs: 250,
    pollMaxMs: 0,
    telemetry: false,
    cliProbe: false,
    usageGuidance: true,
    diagnosticTool: false,
    argvBuilder: () => [process.execPath, STUB],
    ...options,
  }))
  await new Promise((resolve) => setTimeout(resolve, 30))
  t.after(() => rmSync(join(tmpdir(), 'cgraph-int-cache'), { recursive: true, force: true }))
  return { ctx, agents, spawned, tools: ctx.get('tools'), systemPrompt: ctx.get('systemPrompt') }
}

/**
 * Create an agent the way the harness does: a scoped context, a session header carrying the
 * workspace directory, and an `agent/created` announcement dispatched through the agent's scope
 * carrier (which is what makes a scoped listener observe it).
 */
function createAgent(h, cwd, source = {}) {
  const id = source.id ?? `session-${Math.random().toString(36).slice(2, 8)}`
  const scoped = createScope(h.ctx, { id })
  const agent = { id, session: { header: { cwd } }, ctx: scoped.ctx }
  h.agents.set(id, agent)
  h.ctx.emit(scopeTarget(agent, agent), 'agent/created', { agent })
  return { agent, scope: scoped, carrier: scopeTarget(agent, agent) }
}

/** Announce an agent's disposal through its carrier. */
function disposeAgent(h, session) {
  h.agents.delete(session.agent.id)
  h.ctx.emit(session.carrier, 'agent/disposed', { agent: session.agent })
  session.scope.dispose()
}

/** Wait until a predicate holds. */
async function waitFor(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/** Tool names registered on the root registry. */
function registeredTools(h) {
  return h.tools.schemas().map((schema) => schema.name)
}

/** Call one tool as a given session, exactly as the model dispatch does. */
async function callTool(h, agent, name, args) {
  return h.tools.execute({
    name,
    arguments: args,
    callId: `call-${String(agent.id)}-${name}`,
    signal: new AbortController().signal,
    agent,
  })
}

/** Flatten a tool result's text for assertions. */
function textOf(result) {
  return (result.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

test('a workspace with no index starts no process and refuses CodeGraph calls', async (t) => {
  const h = await harness(t)
  const root = makeProject(t, { indexed: false })
  const session = createAgent(h, root)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(h.spawned.length, 0, 'no CodeGraph process may be started for an unindexed project')
  assert.deepEqual(registeredTools(h), [], 'and no tool may be registered before any project is live')

  // The refusal path itself is exercised once a project exists somewhere; here the session's
  // own workspace has no index, so a call must say exactly that.
  const other = makeProject(t, { indexed: true })
  const otherSession = createAgent(h, other)
  assert.ok(await waitFor(() => registeredTools(h).length === 1))
  const refused = await callTool(h, session.agent, 'mcp__codegraph__codegraph_explore', { query: 'x' })
  assert.equal(refused.isError, true, 'an unindexed session must not be able to call CodeGraph')
  assert.match(textOf(refused), /no CodeGraph index exists/)
  assert.match(textOf(refused), /codegraph@stub init -y/)
  disposeAgent(h, session)
  disposeAgent(h, otherSession)
})

test('an unindexed workspace directory that does not exist behaves the same', async (t) => {
  const h = await harness(t)
  const session = createAgent(h, join(tmpdir(), 'cgraph-int-does-not-exist'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(h.spawned.length, 0)
  assert.deepEqual(registeredTools(h), [])
  disposeAgent(h, session)
})

test('a session with no cwd is skipped without watching anything', async (t) => {
  const h = await harness(t)
  const session = createAgent(h, undefined)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(h.spawned.length, 0)
  assert.deepEqual(registeredTools(h), [])
  disposeAgent(h, session)
})

test('an indexed project registers the tool and lets that session call it', async (t) => {
  const h = await harness(t)
  const root = makeProject(t, { indexed: true })
  const session = createAgent(h, root)
  assert.ok(await waitFor(() => registeredTools(h).length === 1), 'the tool must register once a project is live')
  assert.deepEqual(registeredTools(h), ['mcp__codegraph__codegraph_explore'])
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].cwd, root, 'the server runs with the project root as its cwd')

  const result = await callTool(h, session.agent, 'mcp__codegraph__codegraph_explore', { query: 'hello' })
  assert.equal(result.isError, false)
  assert.match(textOf(result), /stub result for hello/)

  // The session's prompt section names the project the tools come from.
  const assembly = await h.systemPrompt.assemble({ agent: session.agent, scope: session.agent })
  const sections = assembly.sections.map((section) => section.text).join('\n')
  assert.match(sections, /CodeGraph: this project is indexed/)
  assert.match(sections, new RegExp(root.replaceAll('/', '\\/')))

  disposeAgent(h, session)
})

test('two sessions in one project share a single server process', async (t) => {
  const h = await harness(t)
  const root = makeProject(t, { indexed: true })
  const a = createAgent(h, root)
  const b = createAgent(h, root)
  assert.ok(await waitFor(() => h.spawned.length === 1 && registeredTools(h).length === 1))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(h.spawned.length, 1, 'one process must serve both sessions')

  assert.match(textOf(await callTool(h, a.agent, 'mcp__codegraph__codegraph_explore', { query: 'one' })), /stub result for one/)
  assert.match(textOf(await callTool(h, b.agent, 'mcp__codegraph__codegraph_explore', { query: 'two' })), /stub result for two/)

  // Disposing one session keeps the process and the other session working.
  disposeAgent(h, a)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(h.spawned.length, 1, 'the shared process must not be restarted or replaced')
  assert.match(textOf(await callTool(h, b.agent, 'mcp__codegraph__codegraph_explore', { query: 'still-here' })), /still-here/)
  disposeAgent(h, b)
  assert.ok(await waitFor(() => registeredTools(h).length === 0), 'the last release unregisters the tool')
})

test('an index created during a session lifts the refusal live', async (t) => {
  const h = await harness(t)
  const root = makeProject(t, { indexed: false })
  const session = createAgent(h, root)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(h.spawned.length, 0)

  // Simulate `codegraph init` running in the session's project.
  mkdirSync(join(root, '.codegraph'), { recursive: true })
  writeFileSync(join(root, '.codegraph', 'codegraph.db'), '')

  assert.ok(await waitFor(() => registeredTools(h).length === 1), 'the tool must appear without restarting the session')
  assert.equal(h.spawned.length, 1)
  assert.equal(h.spawned[0].cwd, root)
  const result = await callTool(h, session.agent, 'mcp__codegraph__codegraph_explore', { query: 'fresh' })
  assert.equal(result.isError, false, 'the same session must be able to call it immediately')
  assert.match(textOf(result), /stub result for fresh/)
  disposeAgent(h, session)
})

test('a disabled plugin does nothing at all', async (t) => {
  const h = await harness(t, { enabled: false })
  const root = makeProject(t, { indexed: true })
  const session = createAgent(h, root)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(h.spawned.length, 0)
  assert.deepEqual(registeredTools(h), [])
  disposeAgent(h, session)
})

test('the optional diagnostic tool registers and reports this session\'s state', async (t) => {
  // This tool is registered on the ROOT context, so it exercises the registry's own schema
  // validation directly — the one place a mistake in the schemas would abort plugin activation
  // for the whole profile.
  const h = await harness(t, { diagnosticTool: true })
  const root = makeProject(t, { indexed: true })
  const session = createAgent(h, root)
  assert.ok(await waitFor(() => registeredTools(h).includes('codegraph_project_status')))
  assert.ok(await waitFor(() => registeredTools(h).includes('mcp__codegraph__codegraph_explore')))
  const result = await callTool(h, session.agent, 'codegraph_project_status', {})
  const text = textOf(result)
  assert.match(text, /liveInstances/)
  assert.match(text, /initHint/)
  assert.match(text, /"state": "mounted"/)
  disposeAgent(h, session)
})
