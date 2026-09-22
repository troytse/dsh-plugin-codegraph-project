/**
 * A stand-in for `ctx.subprocess` that honours the same contract the transport depends on:
 * a `SubprocessHandle` with piped streams, `done`, `terminate()` and `waitForExit()`, plus
 * managed-range kill semantics (`detached` process group on POSIX).
 *
 * It exists so transport, pool, and agent-tool behaviour can be tested with a stub MCP
 * server: no CodeGraph install, no network, no harness process. The real service is the
 * production path and is exercised separately by the integration script.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'

/** Merge the scrubbed-ish parent environment with explicit deltas, like the real service. */
function mergedEnv(extra) {
  const base = { ...process.env }
  for (const key of Object.keys(base)) {
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || key.toUpperCase().startsWith('DSH_')) delete base[key]
  }
  return { ...base, ...(extra ?? {}) }
}

/** Resolve one bare command against PATH. */
export async function resolveExecutable(command, env) {
  if (isAbsolute(command)) {
    accessSync(command, constants.X_OK)
    return command
  }
  const environment = mergedEnv(env)
  for (const directory of String(environment.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = resolve(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch { /* keep looking */ }
  }
  throw new Error(`fake-subprocess: ${JSON.stringify(command)} was not found on PATH`)
}

/**
 * Spawn one managed child.
 *
 * @param {{ argv: string[], cwd: string, stdio?: object, graceMs?: number, env?: object }} spec
 * @returns {object} A `SubprocessHandle`-shaped object.
 */
export function spawn(spec) {
  const [program, ...args] = spec.argv
  const child = nodeSpawn(program, args, {
    cwd: spec.cwd,
    env: mergedEnv(spec.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const graceMs = spec.graceMs ?? 3_000
  // Built by hand rather than `Promise.withResolvers`, which is Node.js 22+ and would make
  // the suite unrunnable on the Node.js 20 the package claims to support.
  let settle
  let fail
  let settled = false
  const outcome = new Promise((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  outcome.catch(() => {})
  let exited = false
  child.once('exit', (code, signal) => {
    exited = true
    settled = true
    settle({ exitCode: code, signal })
  })
  child.once('error', (error) => {
    settled = true
    fail(error)
  })

  const signalGroup = (signal) => {
    if (child.pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal)
        return
      } catch { /* fall through to the direct signal */ }
    }
    try { child.kill(signal) } catch { /* already gone */ }
  }

  let terminating = false
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    collected: {},
    done: outcome,
    terminate() {
      if (terminating || exited) return
      terminating = true
      signalGroup('SIGTERM')
      const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs)
      if (typeof timer.unref === 'function') timer.unref()
      outcome.finally(() => clearTimeout(timer)).catch(() => {})
    },
    async waitForExit() {
      if (!exited && !settled) await outcome.catch(() => {})
      return true
    },
  }
}

/** A `ctx.subprocess`-shaped service backed by the functions above. */
export const fakeSubprocess = { resolveExecutable, spawn }
