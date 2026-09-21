/**
 * A managed stdio transport for the CodeGraph MCP server.
 *
 * The MCP SDK ships its own `StdioClientTransport`, but it spawns through
 * `node:child_process` directly, which would put the CodeGraph process outside DSH's
 * process ownership. This adapter instead launches through `ctx.subprocess`, so the
 * child is a managed process of the harness and inherits its whole teardown story:
 *
 * - `detached` process group + group signalling (TERM, then KILL after `graceMs`),
 * - `waitForExit()` that only reports after the managed range is really gone,
 * - the subprocess service's disposal terminating and awaiting every still-running
 *   managed process, and
 * - a synchronous host-exit finalizer that SIGKILLs survivors on `process.exit`.
 *
 * Teardown order is stdin-first on purpose: CodeGraph exits within milliseconds of
 * stdin closing (measured), so the common path never has to signal anything.
 *
 * @module dsh-plugin-codegraph-project/transport
 */

const DEFAULT_GRACE_MS = 3_000
const DEFAULT_STDERR_TAIL_BYTES = 8_192

/** Raised when the child died before the MCP handshake could complete. */
export class CodegraphStartupError extends Error {
  /**
   * @param {string} message
   * @param {{ stderrTail?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'CodegraphStartupError'
    this.stderrTail = details.stderrTail ?? ''
  }
}

/** Raised when the child died after a successful handshake. */
export class CodegraphConnectionError extends Error {
  /**
   * @param {string} message
   * @param {{ stderrTail?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'CodegraphConnectionError'
    this.stderrTail = details.stderrTail ?? ''
  }
}

/**
 * The MCP `Transport` contract is small: `start`, `send`, `close` plus the
 * `onmessage`/`onerror`/`onclose` callbacks the `Client` installs before connecting.
 * Everything else here is lifecycle bookkeeping the plugin needs.
 */
export class ManagedStdioTransport {
  /**
   * @param {object} options
   * @param {object} options.subprocess - The `ctx.subprocess` service (a hard dependency).
   * @param {string[]} options.argv - Program and arguments; the executable must already be resolved.
   * @param {string} options.cwd - Project root the server should treat as its default project.
   * @param {NodeJS.ProcessEnv} options.env - Environment DELTAS; the service merges the scrubbed parent env.
   * @param {number} [options.graceMs] - TERM-to-KILL grace and host-exit escape hatch.
   * @param {number} [options.stderrTailBytes] - Retained stderr tail used in diagnostics.
   * @param {(line: string) => void} [options.onStderr] - Called per complete stderr line.
   * @param {string} [options.label] - Diagnostic label recorded on errors.
   */
  constructor(options) {
    this.subprocess = options.subprocess
    this.argv = options.argv
    this.cwd = options.cwd
    this.env = options.env ?? {}
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    this.stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES
    this.onStderr = options.onStderr
    this.label = options.label ?? 'codegraph'

    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.handle = undefined
    this.started = false
    this.closed = false
    this.settled = false
    this.exitOutcome = undefined
    this.buffer = ''
    this.stderrBuffer = ''
    this.stderrTail = ''
    this.stdoutStream = undefined
    this.cleanups = []
    this.exitPromise = undefined
  }

  /** Target of the MCP `Transport.onclose` contract. */
  onclose = undefined
  /** Target of the MCP `Transport.onerror` contract. */
  onerror = undefined
  /** Target of the MCP `Transport.onmessage` contract. */
  onmessage = undefined

  /**
   * Launch the child process. Split from the MCP `start()` contract so the caller can
   * race the launch against the handshake and report a spawn failure immediately.
   *
   * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessHandle}
   */
  launch() {
    if (this.handle !== undefined) return this.handle
    const [program, ...args] = this.argv
    const handle = this.subprocess.spawn({
      argv: [program, ...args],
      cwd: this.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.graceMs,
      env: this.env,
    })
    this.handle = handle

    const stdin = handle.stdin
    const stdout = handle.stdout
    const stderr = handle.stderr
    if (stdin !== undefined) {
      // A child that dies mid-write must not surface as an unhandled stream error;
      // the exit path already reports the real failure.
      stdin.on('error', () => {})
    }
    if (stdout !== undefined) {
      this.stdoutStream = stdout
      stdout.setEncoding?.('utf8')
      const onData = (chunk) => this.#ingest(String(chunk))
      stdout.on('data', onData)
      this.cleanups.push(() => stdout.off('data', onData))
    }
    if (stderr !== undefined) {
      stderr.setEncoding?.('utf8')
      const onData = (chunk) => this.#ingestStderr(String(chunk))
      stderr.on('data', onData)
      this.cleanups.push(() => stderr.off('data', onData))
    }

    this.exitPromise = handle.done.then(
      (outcome) => this.#settleExit(outcome),
      (error) => this.#settleExit({ exitCode: null, signal: null, error }),
    )
    return handle
  }

  /**
   * `Transport.start`: the process is launched here for callers that go straight
   * through the MCP `Client` rather than using {@link launch} explicitly.
   */
  async start() {
    if (this.started) return
    this.started = true
    this.launch()
  }

  /**
   * `Transport.send`: one newline-delimited JSON-RPC frame on the child's stdin.
   *
   * @param {object} message
   */
  async send(message) {
    const stdin = this.handle?.stdin
    if (this.closed || stdin === undefined) {
      throw new CodegraphConnectionError(`${this.label}: cannot send, the MCP connection is closed`)
    }
    await new Promise((resolve, reject) => {
      stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`, (error) => {
        if (error) reject(new CodegraphConnectionError(`${this.label}: writing to the MCP server failed`, { cause: error, stderrTail: this.stderrTail }))
        else resolve()
      })
    })
  }

  /**
   * `Transport.close`: stop the server without leaving a process behind.
   *
   * stdin-first (CodeGraph exits on stdin EOF), then the managed ladder as a backstop:
   * TERM, grace, KILL, and an awaited managed-range exit. Idempotent.
   */
  async close() {
    if (this.closed) return
    this.closed = true
    for (const cleanup of this.cleanups.splice(0)) {
      try { cleanup() } catch { /* diagnostics only */ }
    }
    const handle = this.handle
    if (handle === undefined) return
    try { handle.stdin?.end() } catch { /* already gone */ }
    const exited = await this.waitForExit({ timeoutMs: this.graceMs + 2_000 })
    if (exited) return
    try { handle.terminate() } catch { /* ladder already ran */ }
    await this.waitForExit({ timeoutMs: this.graceMs + 5_000 })
  }

  /**
   * Resolve once the managed process range is gone, or the timeout elapses.
   *
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<boolean>} Whether the process range was observed gone.
   */
  async waitForExit(options = {}) {
    const timeoutMs = options.timeoutMs ?? this.graceMs + 2_000
    const handle = this.handle
    if (handle === undefined) return true
    const timer = new Promise((resolve) => {
      const id = setTimeout(() => resolve(false), timeoutMs)
      if (typeof id.unref === 'function') id.unref()
    })
    const settled = (async () => {
      try {
        await handle.waitForExit()
        return true
      } catch {
        return false
      }
    })()
    return Promise.race([settled, timer])
  }

  /** Whether the child process is still running (used for diagnostics). */
  get running() {
    return !this.settled
  }

  /** The recorded exit, once known. */
  get outcome() {
    return this.exitOutcome
  }

  /**
   * Race the MCP handshake against process death and a startup deadline, so a missing
   * npx, a platform bundle that cannot download, or a crash surfaces with the real
   * stderr instead of an opaque handshake timeout.
   *
   * @template T
   * @param {() => Promise<T>} handshake
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<T>}
   */
  async raceHandshake(handshake, options = {}) {
    const timeoutMs = options.timeoutMs ?? 180_000
    const exit = this.exitPromise ?? Promise.resolve(undefined)
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new CodegraphStartupError(`${this.label}: the MCP server did not initialize within ${timeoutMs}ms`, { stderrTail: this.stderrTail }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      return await Promise.race([
        handshake(),
        exit.then((outcome) => {
          throw new CodegraphStartupError(
            `${this.label}: the MCP server exited before initializing (${describeOutcome(outcome)})`,
            { stderrTail: this.stderrTail },
          )
        }),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  #ingest(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch (error) {
        this.onerror?.(new CodegraphConnectionError(`${this.label}: the MCP server wrote a line that is not JSON`, { cause: error }))
        continue
      }
      this.onmessage?.(message)
    }
  }

  #ingestStderr(chunk) {
    this.stderrBuffer += chunk
    let index
    while ((index = this.stderrBuffer.indexOf('\n')) !== -1) {
      const line = this.stderrBuffer.slice(0, index)
      this.stderrBuffer = this.stderrBuffer.slice(index + 1)
      if (line.trim() !== '') this.onStderr?.(line)
    }
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-this.stderrTailBytes)
  }

  #settleExit(outcome) {
    if (this.settled) return this.exitOutcome
    this.settled = true
    this.exitOutcome = outcome
    if (!this.closed) {
      // Transport death is a close, not an out-of-band protocol error: `onclose` is the
      // SDK's signal for it, and a failed request already reports the concrete reason.
      // Reserving `onerror` for framing problems keeps its meaning unambiguous.
      this.onclose?.()
    }
    return outcome
  }
}

/**
 * Render a subprocess outcome for diagnostics.
 *
 * @param {{ exitCode?: number | null, signal?: string | null, error?: unknown } | undefined} outcome
 * @returns {string}
 */
export function describeOutcome(outcome) {
  if (outcome === undefined) return 'no outcome recorded'
  if (outcome.error !== undefined) return `launch failure: ${String(outcome.error?.message ?? outcome.error)}`
  if (outcome.signal !== null && outcome.signal !== undefined) return `signal ${outcome.signal}`
  return `exit code ${String(outcome.exitCode)}`
}
