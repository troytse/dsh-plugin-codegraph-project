/**
 * The managed stdio transport: framing, fast failure, and teardown.
 *
 * The child processes here are tiny inline Node programs, so these assertions cover the
 * adapter's own contract — newline-delimited JSON-RPC framing, prompt failure reporting when
 * the child dies, and a `close()` that leaves nothing running — without a CodeGraph install.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedStdioTransport, describeOutcome } from '../lib/transport.js'
import { fakeSubprocess } from './fake-subprocess.js'

/** A scratch working directory for each spawned child. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cgraph-transport-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Build the argv for an inline Node program. */
function nodeArgv(source) {
  return [process.execPath, '-e', source]
}

/** An inline program that answers every request with a single text content block. */
const ECHO_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === '') continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo ' + msg.method }] } }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
`

test('one JSON-RPC message is written as one line and parsed back', async (t) => {
  const cwd = scratch(t)
  const transport = new ManagedStdioTransport({
    subprocess: fakeSubprocess,
    argv: nodeArgv(ECHO_SERVER),
    cwd,
    env: {},
    graceMs: 500,
  })
  const received = []
  transport.onmessage = (message) => received.push(message)
  transport.launch()
  await transport.start()
  await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
  await waitFor(() => received.length === 1)
  assert.deepEqual(received, [{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'echo ping' }] } }])
  await transport.close()
})

test('several frames arriving in one chunk are separated', async (t) => {
  const cwd = scratch(t)
  const burst = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', () => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'a' }) + '\\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'b' }) + '\\n')
})
`
  const transport = new ManagedStdioTransport({ subprocess: fakeSubprocess, argv: nodeArgv(burst), cwd, env: {}, graceMs: 500 })
  const received = []
  transport.onmessage = (message) => received.push(message)
  transport.launch()
  await transport.send({ jsonrpc: '2.0', id: 1, method: 'go' })
  await waitFor(() => received.length === 2)
  assert.deepEqual(received.map((message) => message.result), ['a', 'b'])
  await transport.close()
})

test('a non-JSON line is reported as an error and does not break the framing', async (t) => {
  const cwd = scratch(t)
  const noisy = `
process.stdout.write('not json at all\\n')
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 7, result: 'fine' }) + '\\n')
`
  const transport = new ManagedStdioTransport({ subprocess: fakeSubprocess, argv: nodeArgv(noisy), cwd, env: {}, graceMs: 500 })
  const errors = []
  const received = []
  transport.onerror = (error) => errors.push(error)
  transport.onmessage = (message) => received.push(message)
  transport.launch()
  await waitFor(() => received.length === 1)
  assert.equal(received[0].id, 7)
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /is not JSON/)
  await transport.close()
})

test('a child that dies immediately fails the handshake race with its stderr retained', async (t) => {
  const cwd = scratch(t)
  const transport = new ManagedStdioTransport({
    subprocess: fakeSubprocess,
    argv: nodeArgv('process.stderr.write("boom: no index\\n"); process.exit(4)'),
    cwd,
    env: {},
    graceMs: 500,
  })
  transport.launch()
  await assert.rejects(
    () => transport.raceHandshake(() => new Promise(() => {}), { timeoutMs: 2_000 }),
    (error) => {
      assert.equal(error.name, 'CodegraphStartupError')
      assert.match(error.message, /exited before initializing \(exit code 4\)/)
      return true
    },
  )
  assert.match(transport.stderrTail, /boom: no index/)
  await transport.close()
})

test('the handshake race reports a deadline instead of hanging', async (t) => {
  const cwd = scratch(t)
  const transport = new ManagedStdioTransport({
    subprocess: fakeSubprocess,
    argv: nodeArgv('setTimeout(() => {}, 60000)'),
    cwd,
    env: {},
    graceMs: 500,
  })
  transport.launch()
  await assert.rejects(
    () => transport.raceHandshake(() => new Promise(() => {}), { timeoutMs: 60 }),
    /did not initialize within 60ms/,
  )
  await transport.close()
})

test('close() stops a server that ignores stdin EOF, and is idempotent', async (t) => {
  const cwd = scratch(t)
  const stubborn = `
// Read stdin but never exit on EOF: only a signal stops this process.
process.stdin.resume()
setInterval(() => {}, 1000)
`
  const transport = new ManagedStdioTransport({ subprocess: fakeSubprocess, argv: nodeArgv(stubborn), cwd, env: {}, graceMs: 300 })
  transport.launch()
  const pid = transport.handle.pid
  assert.ok(isAlive(pid))
  await transport.close()
  assert.ok(!isAlive(pid), 'close() must leave no process behind')
  await transport.close()
  assert.equal(transport.running, false)
})

test('close() before launch is a no-op, and send after close fails loudly', async (t) => {
  const cwd = scratch(t)
  const transport = new ManagedStdioTransport({ subprocess: fakeSubprocess, argv: nodeArgv(ECHO_SERVER), cwd, env: {}, graceMs: 200 })
  await transport.close()
  await assert.rejects(() => transport.send({ jsonrpc: '2.0', id: 1, method: 'x' }), /connection is closed/)
})

test('an unexpected exit closes the transport once and records the outcome', async (t) => {
  const cwd = scratch(t)
  const transport = new ManagedStdioTransport({ subprocess: fakeSubprocess, argv: nodeArgv('setTimeout(() => process.exit(9), 30)'), cwd, env: {}, graceMs: 200 })
  let closes = 0
  transport.onclose = () => { closes += 1 }
  transport.launch()
  assert.ok(await waitFor(() => closes > 0))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(closes, 1, 'death is reported as exactly one close')
  assert.equal(transport.outcome?.exitCode, 9)
  assert.equal(describeOutcome(transport.outcome), 'exit code 9')
  assert.equal(transport.running, false)
})

test('outcomes render readably for diagnostics', () => {
  assert.equal(describeOutcome({ exitCode: 0, signal: null }), 'exit code 0')
  assert.equal(describeOutcome({ exitCode: null, signal: 'SIGKILL' }), 'signal SIGKILL')
  assert.equal(describeOutcome({ error: new Error('nope') }), 'launch failure: nope')
  assert.equal(describeOutcome(undefined), 'no outcome recorded')
})

/** Whether a pid is alive. */
function isAlive(pid) {
  if (pid === undefined || pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait until a predicate holds. */
async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}
