// Raw NDJSON stdio protocol probe against the real codegraph MCP server,
// using plain pipes exactly like the planned @deepseek-ai/dsh-subprocess transport.
import { spawn } from 'node:child_process'

const PROJECT = process.argv[2] ?? process.cwd()
const VERSION = process.argv[3] ?? '1.6.0'

const env = { ...process.env, npm_config_cache: process.env.npm_config_cache ?? `${process.env.HOME ?? '.'}/.dsh/codegraph/npm-cache` }
const child = spawn('npx', ['-y', `@colbymchenry/codegraph@${VERSION}`, 'serve', '--mcp'], {
  cwd: PROJECT,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
})

const t0 = Date.now()
let buf = ''
const pending = new Map()
let stderrTail = ''

child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000) })

child.on('exit', (code, signal) => {
  console.log(JSON.stringify({ event: 'child-exit', code, signal, ms: Date.now() - t0 }))
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buf += chunk
  let index
  while ((index = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, index).trim()
    buf = buf.slice(index + 1)
    if (line === '') continue
    let msg
    try { msg = JSON.parse(line) } catch { console.log(JSON.stringify({ event: 'unparsed', line: line.slice(0, 200) })); continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    } else {
      console.log(JSON.stringify({ event: 'notification', method: msg.method }))
    }
  }
})

function request(id, method, params, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

const init = await request(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'dsh-codegraph-project-probe', version: '0.0.0' },
})
notify('notifications/initialized')
console.log(JSON.stringify({
  event: 'initialize',
  ms: Date.now() - t0,
  protocolVersion: init.result?.protocolVersion,
  server: init.result?.serverInfo,
  hasInstructions: typeof init.result?.instructions === 'string',
}))

const list = await request(2, 'tools/list', {})
console.log(JSON.stringify({ event: 'tools/list', tools: list.result.tools.map((t) => ({ name: t.name, required: t.inputSchema?.required })) }))

const [a, b] = await Promise.all([
  request(3, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'beta' } }),
  request(4, 'tools/call', { name: 'codegraph_explore', arguments: { query: 'delta' } }),
])
console.log(JSON.stringify({
  event: 'concurrent-calls',
  aError: a.result?.isError === true,
  bError: b.result?.isError === true,
  aHead: (a.result?.content?.[0]?.text ?? '').slice(0, 90).replace(/\n/g, ' | '),
  bHead: (b.result?.content?.[0]?.text ?? '').slice(0, 90).replace(/\n/g, ' | '),
}))

// Closing stdin is codegraph's documented teardown signal.
const closedAt = Date.now()
child.stdin.end()
const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 8000)
  child.on('exit', () => { clearTimeout(timer); resolve(true) })
})
console.log(JSON.stringify({ event: 'stdin-close-exit', exited, ms: Date.now() - closedAt, stderrTail: stderrTail.slice(-300) }))

if (!exited) {
  // Last resort, mirroring the managed-process ladder.
  try { process.kill(-child.pid, 'SIGKILL') } catch {}
  const killed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000)
    child.on('exit', () => { clearTimeout(timer); resolve(true) })
  })
  console.log(JSON.stringify({ event: 'sigkill-group', exited: killed }))
}
process.exit(0)
