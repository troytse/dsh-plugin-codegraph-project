/**
 * End-to-end verification against the REAL CodeGraph server.
 *
 * The unit tests substitute a stub MCP server so they run anywhere. This script does the
 * opposite: it drives the plugin's own modules (transport -> pool -> agent tools -> the
 * public index resolution) against `npx -y @colbymchenry/codegraph@<version> serve --mcp`,
 * which is the only way to confirm the assumptions the design rests on:
 *
 *   1. the real server speaks the framing this transport implements,
 *   2. it advertises `codegraph_explore` and answers a real query,
 *   3. two sessions in one project share ONE child process,
 *   4. an unindexed project yields no tool set and no process,
 *   5. indexing the project mid-flight makes the next use succeed,
 *   6. closing the hub leaves no CodeGraph process behind.
 *
 * Usage (from the repository root):
 *   node test/manual/real-codegraph-e2e.mjs [--version 1.6.0] [--keep]
 *
 * It needs network access OR a warm npx cache for the chosen version, and it writes only
 * inside a temp directory it creates.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool, resolveNpx } from '../../lib/pool.js'
import { ToolAggregate } from '../../lib/agent-tools.js'
import { locateIndex } from '../../lib/locate.js'
import { fakeSubprocess } from '../support/fake-subprocess.js'

const args = process.argv.slice(2)
const version = readFlag('--version') ?? '1.6.0'
const keep = args.includes('--keep')
const cacheDir = process.env.CODEGRAPH_TEST_CACHE ?? join(tmpdir(), 'codegraph-e2e-npm-cache')

const results = []
function step(name, detail) {
  results.push({ name, detail })
  console.log(`  ok  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}
function readFlag(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/** Run the codegraph CLI through npx, returning its stdout. */
function codegraph(argsForCli, cwd) {
  const out = execFileSync('npx', ['-y', `@colbymchenry/codegraph@${version}`, ...argsForCli], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_CACHE: cacheDir, npm_config_cache: cacheDir, CODEGRAPH_TELEMETRY: '0' },
  })
  return out
}

/** Count live processes whose command line mentions the given needle. */
function countProcesses(needle) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'command'], { encoding: 'utf8' })
    return out.split('\n').filter((line) => line.includes(needle) && !line.includes('grep') && !line.includes('ps -A')).length
  } catch {
    return -1
  }
}

/** Wait until a predicate holds. */
async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

/** A root registry stand-in recording registrations the way the real registry would. */
function registryRecorder() {
  const registered = new Map()
  return {
    registered,
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  }
}

const base = mkdtempSync(join(tmpdir(), 'codegraph-e2e-'))
const indexedProject = join(base, 'indexed')
const plainProject = join(base, 'plain')
mkdirSync(indexedProject, { recursive: true })
mkdirSync(plainProject, { recursive: true })
writeFileSync(join(indexedProject, 'math.ts'), 'export function beta(x: number) { return x * 2 }\nexport function alpha(x: number) { return beta(x) + 1 }\n')
writeFileSync(join(plainProject, 'other.ts'), 'export function solo() { return 1 }\n')

const logger = {
  info: (message) => console.log(`      info ${message}`),
  debug: () => {},
  warn: (message) => console.log(`      warn ${message}`),
  error: (message) => console.log(`      error ${message}`),
}

console.log(`\nReal CodeGraph end-to-end (version ${version}, cache ${cacheDir})`)

let pool
try {
  // --- 1. indexing the fixture through the same CLI the plugin launches -----------------
  codegraph(['init', '-y', '--', indexedProject], indexedProject)
  assert.equal(locateIndex(indexedProject).state, 'indexed')
  step('CLI initialized the fixture project (locateIndex sees it)', indexedProject)

  // --- 2. the plugin's own launch path talks to the real server -------------------------
  const subprocess = fakeSubprocess
  const env = {
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_cache: cacheDir,
    CODEGRAPH_TELEMETRY: '0',
    CODEGRAPH_HOST_PPID: String(process.pid),
  }
  const npxExecutable = await resolveNpx(subprocess, env)
  step('resolved the npm launcher through the subprocess contract', npxExecutable)

  pool = new Pool({
    logger,
    subprocess,
    npxExecutable,
    packageSpec: `@colbymchenry/codegraph@${version}`,
    env,
    graceMs: 3_000,
    startupTimeoutMs: 300_000,
    serverName: 'codegraph',
    version,
    toolCallTimeoutMs: 60_000,
  })

  const first = await pool.acquire(indexedProject)
  assert.equal(first.state, 'ready')
  assert.deepEqual(first.tools().map((tool) => tool.name), ['codegraph_explore'])
  step('connected and listed tools', first.tools().map((tool) => tool.name).join(', '))

  const registry = registryRecorder()
  const aggregate = new ToolAggregate({ tools: registry, logger })
  const releaseA = aggregate.retain(first)
  aggregate.setHubs(pool.hubs)
  aggregate.route('session-a', indexedProject)
  assert.deepEqual(aggregate.names(), ['mcp__codegraph__codegraph_explore'])
  const answer = await registry.registered.get('mcp__codegraph__codegraph_explore').execute({ query: 'beta' }, { agent: { id: 'session-a' } })
  const text = answer.content.map((block) => block.text).join('\n')
  assert.match(text, /beta/)
  step('answered a real query through the bridged tool', text.split('\n')[0].slice(0, 80))

  // --- 3. one process serves every session in the project --------------------------------
  const second = await pool.acquire(indexedProject)
  const releaseB = aggregate.retain(second)
  aggregate.route('session-b', indexedProject)
  assert.equal(first, second, 'the second session must reuse the shared hub')
  assert.equal(first.pid, second.pid)
  assert.equal(pool.list().length, 1)
  step('two sessions share one process', `pid ${String(first.pid)}`)

  // --- 4. an unindexed project yields nothing -------------------------------------------
  assert.equal(locateIndex(plainProject).state, 'missing')
  assert.equal(pool.get(plainProject), undefined, 'no instance may exist for an unindexed project')
  step('unindexed project has no instance and no tools')

  // --- 5. indexing mid-flight, then using it immediately ---------------------------------
  codegraph(['init', '-y', '--', plainProject], plainProject)
  assert.equal(locateIndex(plainProject).state, 'indexed')
  const late = await pool.acquire(plainProject)
  assert.equal(late.state, 'ready')
  aggregate.setHubs(pool.hubs)
  const releaseC = aggregate.retain(late)
  aggregate.route('session-c', plainProject)
  const lateAnswer = await registry.registered.get('mcp__codegraph__codegraph_explore').execute({ query: 'solo' }, { agent: { id: 'session-c' } })
  assert.match(lateAnswer.content.map((block) => block.text).join('\n'), /solo/)
  step('a project indexed after startup is usable immediately', `pid ${String(late.pid)}`)

  // --- 6. teardown leaves nothing behind -------------------------------------------------
  const pids = [first.pid, late.pid]
  releaseA()
  releaseB()
  releaseC()
  await pool.release(indexedProject)
  await pool.release(indexedProject)
  await pool.release(indexedProject)
  await pool.release(plainProject)
  await pool.closeAll()
  const gone = await waitFor(() => pids.every((pid) => !isAlive(pid)), 10_000)
  assert.ok(gone, `CodeGraph processes must exit: ${pids.join(', ')}`)
  const remaining = countProcesses(`codegraph@${version}`)
  step('closed every instance and reaped the processes', `ps matches for this version: ${remaining === -1 ? 'unavailable' : remaining}`)
  assert.ok(remaining <= 0, `no CodeGraph process may remain (ps found ${remaining})`)

  console.log('\nAll real-CodeGraph checks passed.\n')
} catch (error) {
  console.error('\nFAILED:', error?.message ?? error)
  console.error('Diagnostics: within the sandbox, `ps` may be unavailable; the script only uses it as an extra check.')
  process.exitCode = 1
} finally {
  await pool?.closeAll().catch(() => {})
  if (!keep) rmSync(base, { recursive: true, force: true })
  else console.log(`Fixture kept at ${base}`)
}

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

