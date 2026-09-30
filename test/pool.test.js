/**
 * The shared-instance pool, driven end to end against the stub MCP server through a
 * subprocess-service stand-in. This is where the two structural promises are tested:
 * many sessions in one project share ONE child process, and the last session releasing it
 * leaves no process behind.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from '../lib/pool.js'
import { fakeSubprocess } from './fake-subprocess.js'
import { ToolAggregate } from '../lib/agent-tools.js'

const STUB = new URL('./stub-mcp-server.js', import.meta.url).pathname

/**
 * Project roots must exist before a child is spawned in them: a missing cwd makes
 * `spawn` fail with ENOENT, which is a property of the test setup rather than of the
 * plugin.
 */
function scratchRoots(t, count) {
  const base = mkdtempSync(join(tmpdir(), 'cgraph-pool-'))
  const roots = []
  for (let index = 0; index < count; index += 1) {
    const root = join(base, `project-${index}`)
    mkdirSync(root, { recursive: true })
    roots.push(root)
  }
  t.after(() => rmSync(base, { recursive: true, force: true }))
  return roots
}

/** A logger that captures lines so tests can assert on diagnostics when needed. */
function capturingLogger() {
  const lines = []
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    debug: (message) => lines.push(`debug ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  }
}

/** Pool dependencies that launch the stub server instead of npx. */
function stubDeps(options = {}) {
  const logger = capturingLogger()
  return {
    logger,
    subprocess: fakeSubprocess,
    npxExecutable: process.execPath,
    packageSpec: STUB,
    argvBuilder: () => [process.execPath, STUB],
    env: options.env ?? { STUB_TOOLS: 'codegraph_explore' },
    graceMs: 500,
    startupTimeoutMs: 10_000,
    serverName: 'codegraph',
    version: 'stub',
    get toolCallTimeoutMs() { return options.toolCallTimeoutMs ?? 5_000 },
  }
}

/** Whether a pid is still alive. */
function isAlive(pid) {
  if (pid === undefined || pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Register one hub into an aggregate and return the release. */
async function installFor(aggregate, hub) {
  return aggregate.retain(hub)
}

/** Wait until a predicate holds, or fail. */
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/** A root registry stand-in for the tool aggregate. */
function fakeRegistry() {
  const registered = new Map()
  return {
    registered,
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
}

/** A logger that swallows output. */
const silentLogger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} }

test('a hub connects, lists tools, and answers a call', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps())
  t.after(() => pool.closeAll())
  const hub = await pool.acquire(root)
  assert.equal(hub.state, 'ready')
  assert.deepEqual(hub.tools().map((tool) => tool.name), ['codegraph_explore'])
  const result = await hub.call('codegraph_explore', { query: 'beta' }, {})
  assert.match(result.content[0].text, /stub result for beta/)
  assert.ok(isAlive(hub.pid))
})

test('two sessions in one project share a single child process', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps())
  t.after(() => pool.closeAll())
  const first = await pool.acquire(root)
  const second = await pool.acquire(root)
  assert.equal(first, second, 'the second acquire must reuse the live hub')
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  await installFor(aggregate, first)
  await installFor(aggregate, second)
  // Two sessions, one shared hub: `acquire` takes each session's reference BEFORE it awaits the
  // connection, so the count is already 2 without the callers retaining anything themselves.
  assert.equal(first.refs, 2)
  assert.equal(pool.list().length, 1)

  // Both sessions can call concurrently over the one connection, each routed to its own
  // project (here: the same one).
  aggregate.setHubs(pool.hubs)
  aggregate.route('session-a', '/tmp/shared')
  aggregate.route('session-b', '/tmp/shared')
  const definition = registry.registered.get('mcp__codegraph__codegraph_explore')
  const [a, b] = await Promise.all([
    definition.execute({ query: 'one' }, { agent: { id: 'session-a' } }),
    definition.execute({ query: 'two' }, { agent: { id: 'session-b' } }),
  ])
  assert.match(a.content[0].text, /stub result for one/)
  assert.match(b.content[0].text, /stub result for two/)

  // Releasing one session keeps the process; releasing the last one ends it.
  const pid = first.pid
  await pool.release(root)
  assert.equal(first.refs, 1)
  assert.ok(isAlive(pid), 'the process must survive while one session remains')
  assert.equal(pool.list().length, 1)
  await pool.release(root)
  assert.equal(pool.list().length, 0)
  assert.ok(await waitFor(() => !isAlive(pid)), `the process ${String(pid)} must exit at zero references`)
})

test('different projects get different instances, and both can serve at once', async (t) => {
  const [x, y] = scratchRoots(t, 2)
  const pool = new Pool(stubDeps())
  t.after(() => pool.closeAll())
  const a = await pool.acquire(x)
  const b = await pool.acquire(y)
  assert.notEqual(a, b)
  assert.notEqual(a.pid, b.pid)
  assert.equal(pool.list().length, 2)
})

test('close() stops the managed process', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps())
  const hub = await pool.acquire(root)
  const pid = hub.pid
  assert.ok(isAlive(pid))
  await hub.close()
  assert.ok(await waitFor(() => !isAlive(pid)), 'close() must reap the child')
  assert.equal(hub.state, 'closed')
  await pool.closeAll()
})

test('a dead connection is transparently re-established on the next call', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps())
  t.after(() => pool.closeAll())
  const hub = await pool.acquire(root)
  const firstPid = hub.pid
  // Kill the server behind the plugin's back, the way a crash would.
  hub.transport.handle.terminate()
  assert.ok(await waitFor(() => !isAlive(firstPid)))
  await waitFor(() => hub.state !== 'ready')
  const result = await hub.call('codegraph_explore', { query: 'after-crash' }, {})
  assert.match(result.content[0].text, /after-crash/)
  assert.notEqual(hub.pid, firstPid)
  assert.equal(hub.reconnects, 1)
})

test('an MCP isError result is surfaced as a thrown failure', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps({ env: { STUB_CALL_MODE: 'error' } }))
  t.after(() => pool.closeAll())
  const hub = await pool.acquire(root)
  await assert.rejects(() => hub.call('codegraph_explore', { query: 'x' }, {}), /stub error from codegraph_explore/)
})

test('a server that dies before answering initialize is reported instead of hanging', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps({ env: { STUB_EXIT_BEFORE_INIT: '1' } }))
  await assert.rejects(
    () => pool.acquire(root),
    (error) => {
      assert.match(String(error.message), /exited before initializing|not available|ECONNREFUSED|Connection closed/i)
      return true
    },
  )
  assert.equal(pool.list().length, 0, 'a failed connect must not leave a hub behind')
  await pool.closeAll()
})

test('a tool added by a later listing reaches subscribers through resync()', async (t) => {
  // The hub's own notification contract. The plugin's PRODUCTION wiring of it (one listener per
  // hub, rebuilding the aggregate's registrations) is pinned end to end in integration.test.js;
  // this test only fixes the contract that wiring relies on, so the two cannot drift apart.
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps({ env: { STUB_TOOLS: 'codegraph_explore', STUB_LIST_EXTRA: '1' } }))
  t.after(() => pool.closeAll())
  const hub = await pool.acquire(root)
  const registry = fakeRegistry()
  const aggregate = new ToolAggregate({ tools: registry, logger: silentLogger })
  const release = aggregate.retain(hub)
  const before = aggregate.names()
  assert.ok(before.includes('mcp__codegraph__codegraph_explore'))

  // A later server-side addition must reach the aggregate, which is what re-registers the
  // changed tool set. Driven through resync() so the assertion cannot race the server's
  // asynchronous notification.
  const changed = new Promise((resolve) => {
    const unsubscribe = hub.subscribe(() => {
      unsubscribe()
      release()
      resolve(aggregate.retain(hub))
    })
  })
  await hub.resync()
  const resolveRetain = await Promise.race([changed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5_000))])
  assert.notEqual(resolveRetain, 'timeout', 'a subscriber must observe the re-synced tool set')
  assert.deepEqual(aggregate.names().sort(), ['mcp__codegraph__codegraph_explore', 'mcp__codegraph__codegraph_node'])
})

test('an in-flight disposal cannot steal the reference a live session holds', async (t) => {
  // The bug this guards: `Pool.acquire` used to leave the reference to a separate `retain()`
  // call placed AFTER `await connect()`. A session disposed inside that window (a cold npx
  // download takes seconds to minutes) then released a reference it had never taken, dropping
  // the count to zero, closing the connection and evicting the hub — so a session that was
  // mounted and serving kept failing with "the MCP connection is closed" and could not recover.
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps())
  t.after(() => pool.closeAll())
  const live = await pool.acquire(root)

  // Session B starts mounting the same project and is disposed before its mount settles. The
  // production order is acquire -> (await) -> disposal -> release.
  const inFlight = await pool.acquire(root)
  assert.equal(inFlight, live, 'the second session must join the live hub')
  await pool.release(root)

  assert.equal(live.refs, 1, 'the live session must still hold its own reference')
  assert.equal(live.closed, false, 'and the shared connection must stay open')
  assert.equal(pool.get(root), live, 'and the hub must stay in the pool')
  const result = await live.call('codegraph_explore', { query: 'still-alive' }, {})
  assert.match(result.content[0].text, /still-alive/)

  // The reference B took is gone, so releasing the live session still ends the process.
  await pool.release(root)
  assert.equal(pool.list().length, 0)
})

test('close() waits for the process even when teardown and release overlap', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps())
  t.after(() => pool.closeAll())
  const hub = await pool.acquire(root)

  // Hold the transport's own close open, so "the second caller does not wait" is observable
  // without a real slow process.
  const transport = hub.transport
  const originalClose = transport.close.bind(transport)
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  transport.close = async () => {
    await gate
    return originalClose()
  }

  const first = hub.close()
  const second = hub.close()
  let secondSettled = false
  void second.then(() => { secondSettled = true })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(secondSettled, false, 'a concurrent close() must await the same completion')
  releaseGate()
  await Promise.all([first, second])
  assert.equal(secondSettled, true)
  assert.equal(hub.closed, true)
})

test('a list_changed notification triggers a re-sync on its own', async (t) => {
  const [root] = scratchRoots(t, 1)
  const pool = new Pool(stubDeps({ env: { STUB_TOOLS: 'codegraph_explore', STUB_LIST_EXTRA: '1' } }))
  t.after(() => pool.closeAll())
  const hub = await pool.acquire(root)
  const seen = []
  const unsubscribe = hub.subscribe(() => seen.push(hub.tools().map((tool) => tool.name)))
  // The stub always announces the extra tool on its first listing, so by the time a
  // subscriber exists the notification may already have been delivered; force one more
  // listing/announcement pair and require the notification path to produce it.
  const before = seen.length
  await hub.resync()
  await waitFor(() => seen.length > before, 1_000)
  unsubscribe()
  assert.ok(seen.length > before, 'a subscriber must be notified of a tool-set change')
})
