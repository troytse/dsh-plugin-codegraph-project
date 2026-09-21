/**
 * One CodeGraph MCP instance per project root, shared by every session that works in it.
 *
 * A session's workspace decides which project it belongs to; sessions in the same project
 * share a single CodeGraph process (and a single SQLite index connection) through
 * reference counting, while each session still gets its own tool registrations in its own
 * scope. The plugin therefore maintains exactly one child process per live project, and
 * none at all for projects with no index.
 *
 * @module dsh-plugin-codegraph-project/pool
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { ManagedStdioTransport, CodegraphConnectionError, CodegraphStartupError, describeOutcome } from './transport.js'

/** Client identity reported to the MCP server. */
const CLIENT_INFO = { name: 'dsh-plugin-codegraph-project', version: '0.1.0' }

/**
 * Candidate executables that launch an npm package without a global install.
 * On Windows the launcher is a `.cmd` shim; POSIX uses the bare name.
 *
 * @param {string} [platform]
 * @returns {string[]}
 */
export function executableCandidates(platform = process.platform) {
  return platform === 'win32' ? ['npx.cmd', 'npx.exe', 'npx'] : ['npx']
}

/**
 * Resolve the first candidate the subprocess service can execute.
 *
 * @param {object} subprocess - The `ctx.subprocess` service.
 * @param {NodeJS.ProcessEnv} env - Environment deltas used for PATH lookup.
 * @param {string} [platform]
 * @returns {Promise<string>} Canonical executable path.
 */
export async function resolveNpx(subprocess, env, platform = process.platform) {
  const attempts = []
  for (const candidate of executableCandidates(platform)) {
    try {
      return await subprocess.resolveExecutable(candidate, env)
    } catch (error) {
      attempts.push(`${candidate}: ${String(error?.message ?? error)}`)
    }
  }
  throw new Error(`could not resolve an npm launcher (${attempts.join('; ')}); install Node.js with npm, or set packageSpec/cacheDir appropriately`)
}

/** Lifecycle states a hub moves through. */
export const HUB_STATE = Object.freeze({
  connecting: 'connecting',
  ready: 'ready',
  failed: 'failed',
  closed: 'closed',
})

/**
 * One shared CodeGraph project connection.
 */
export class ProjectHub {
  /**
   * @param {object} options
   * @param {string} options.projectRoot
   * @param {object} options.deps - Pool dependencies (subprocess, packageSpec, env, timeouts, logger).
   */
  constructor(options) {
    const { projectRoot, deps } = options
    this.projectRoot = projectRoot
    this.deps = deps
    this.serverName = deps.serverName
    this.toolCallTimeoutMs = deps.toolCallTimeoutMs
    this.state = HUB_STATE.connecting
    this.pid = undefined
    this.connectPromise = undefined
    this.closed = false
    /** Successful lazy reconnects performed after a connection loss. */
    this.reconnects = 0
    /** @type {Set<() => void>} Subscribers notified when the available tool set changes. */
    this.listeners = new Set()
    /** @type {Array<{ name: string, description?: string, inputSchema?: object }>} */
    this.toolList = []
    this.client = undefined
    this.transport = undefined
  }

  /** The tools currently advertised by this project's server. */
  tools() {
    return this.toolList
  }

  /**
   * Register a listener for tool-set changes (a re-sync happened).
   *
   * @param {() => void} listener
   * @returns {() => void} Remover.
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Connect, initialize, and fetch the initial tool set. Idempotent: concurrent callers
   * share one attempt.
   *
   * @returns {Promise<ProjectHub>}
   */
  async connect() {
    if (this.connectPromise !== undefined) return this.connectPromise
    this.connectPromise = this.#connect().catch((error) => {
      this.state = HUB_STATE.failed
      this.lastError = error
      this.connectPromise = undefined
      throw error
    })
    return this.connectPromise
  }

  async #connect() {
    if (this.reconnects > 0) {
      this.deps.logger.info(`reconnecting CodeGraph MCP server for ${this.projectRoot} (attempt ${this.reconnects})`)
    }
    // Production resolves the npm launcher here, through the same subprocess service that
    // will own the child (an unresolvable launcher is reported with its real reason instead
    // of surfacing as an opaque spawn failure). Tests substitute an argv that launches a stub
    // MCP server, so the client, transport, and tool-registration paths stay the real ones.
    let argv
    if (this.deps.argvBuilder === undefined) {
      const launcher = await resolveNpx(this.deps.subprocess, this.deps.env)
      argv = [launcher, '-y', this.deps.packageSpec, 'serve', '--mcp']
    } else {
      argv = this.deps.argvBuilder(this.deps)
    }
    const transport = new ManagedStdioTransport({
      subprocess: this.deps.subprocess,
      argv,
      cwd: this.projectRoot,
      env: this.deps.env,
      graceMs: this.deps.graceMs,
      label: `codegraph(${this.projectRoot})`,
      onStderr: (line) => this.deps.logger.debug(`[${this.projectRoot}] ${line}`),
    })
    this.transport = transport
    const handle = transport.launch()
    this.pid = handle?.pid
    this.deps.logger.info(`starting CodeGraph MCP server for ${this.projectRoot} (${this.deps.packageSpec}, pid ${String(this.pid ?? 'unknown')})`)

    const client = new Client(CLIENT_INFO, { capabilities: {} })
    this.client = client
    // `notifications/tools/list_changed` is optional; a client that cannot register the
    // handler still works, it just never re-syncs on a live tool-list change.
    if (typeof client.setNotificationHandler === 'function') {
      try {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => { void this.resync() })
      } catch (error) {
        this.deps.logger.debug(`tool-list-change notifications unavailable: ${String(error?.message ?? error)}`)
      }
    }

    await transport.raceHandshake(async () => {
      await client.connect(transport)
    }, { timeoutMs: this.deps.startupTimeoutMs })

    await this.resync()
    this.state = HUB_STATE.ready
    // A later connection loss must be able to reconnect: leaving the resolved promise in
    // place would make every subsequent `connect()` return the dead connection. The
    // transport's own settled flag is the authoritative signal, and `call()` also handles
    // the narrower window where an in-flight request discovers the loss first.
    this.transport.exitPromise?.then(() => this.retireTransport(transport), () => this.retireTransport(transport))
    return this
  }

  /**
   * Mark a specific (now dead) transport as retired so the next use reconnects.
   *
   * Guarded by identity: a reconnect that already installed a newer transport must not be
   * disturbed by the old one settling.
   *
   * @param {ManagedStdioTransport} transport
   */
  retireTransport(transport) {
    if (this.transport !== transport) return
    if (this.closed) return
    if (this.state === HUB_STATE.ready) this.state = HUB_STATE.failed
    this.connectPromise = undefined
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { this.deps.logger.warn(`codegraph tool-set listener failed: ${String(error?.message ?? error)}`) }
    }
  }

  /**
   * Fetch the server's tool list and publish it.
   *
   * @returns {Promise<void>}
   */
  async resync() {
    const client = this.client
    if (client === undefined) return
    const result = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema)
    this.toolList = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }))
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { this.deps.logger.warn(`codegraph tool-set listener failed: ${String(error?.message ?? error)}`) }
    }
  }

  /**
   * Invoke one MCP tool on this project's connection.
   *
   * A reconnect is attempted once when the connection is not ready, because a session can
   * easily outlive the server (a crash, a memory-constrained host). The next call after a
   * successful reconnect works; a failed reconnect reports the real reason.
   *
   * @param {string} rawName - Wire name of the tool.
   * @param {object} args - Validated arguments.
   * @param {{ signal?: AbortSignal }} [exec]
   * @returns {Promise<object>} Raw MCP result.
   */
  async call(rawName, args, exec) {
    if (this.closed) throw new CodegraphConnectionError(`codegraph(${this.projectRoot}): the MCP connection is closed`, { stderrTail: this.stderrTail })
    const live = this.transport
    if (this.state !== HUB_STATE.ready || live === undefined || live.settled) {
      this.reconnects += 1
      await this.connect().catch(() => {})
    }
    const client = this.client
    if (client === undefined || this.state !== HUB_STATE.ready) {
      throw new CodegraphConnectionError(`codegraph(${this.projectRoot}): the MCP connection is not available`, { stderrTail: this.stderrTail })
    }
    try {
      const result = await client.callTool({ name: rawName, arguments: args }, undefined, {
        signal: exec?.signal,
        timeout: this.toolCallTimeoutMs,
      })
      if (result?.isError === true) {
        throw new CodegraphConnectionError(extractErrorText(result, rawName), { stderrTail: this.stderrTail })
      }
      return result
    } catch (error) {
      // The transport can die between the readiness check and the request (or while it is
      // in flight), which the SDK reports as a plain "Not connected" failure. One
      // transparent reconnect keeps a long session working across a server crash.
      if (error instanceof CodegraphConnectionError) throw error
      if (!isConnectionLoss(error)) throw error
      this.reconnects += 1
      this.retireTransport(this.transport)
      await this.connect().catch(() => {})
      if (this.client === undefined || this.state !== HUB_STATE.ready) {
        throw new CodegraphConnectionError(`codegraph(${this.projectRoot}): the MCP server is not responding`, { cause: error, stderrTail: this.stderrTail })
      }
      const retried = await this.client.callTool({ name: rawName, arguments: args }, undefined, {
        signal: exec?.signal,
        timeout: this.toolCallTimeoutMs,
      })
      if (retried?.isError === true) {
        throw new CodegraphConnectionError(extractErrorText(retried, rawName), { stderrTail: this.stderrTail })
      }
      return retried
    }
  }

  /** Reference-count bookkeeping: one live agent started using this hub. */
  retain() {
    this.refs += 1
    return this.refs
  }

  /** Reference-count bookkeeping: one live agent stopped using this hub. */
  release() {
    this.refs = Math.max(0, this.refs - 1)
    return this.refs
  }

  /** Live reference count. */
  refs = 0

  /** Retained stderr tail of the child process, for diagnostics. */
  get stderrTail() {
    return this.transport?.stderrTail ?? ''
  }

  /**
   * Stop the server and wait for its managed process to be gone.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) return
    this.closed = true
    this.state = HUB_STATE.closed
    this.listeners.clear()
    const client = this.client
    const transport = this.transport
    this.client = undefined
    try { await client?.close() } catch { /* the transport close path owns the failure */ }
    try { await transport?.close() } catch (error) {
      this.deps.logger.warn(`closing CodeGraph for ${this.projectRoot} failed: ${String(error?.message ?? error)}`)
    }
  }

  /** A detached, JSON-safe description of this hub for logs and diagnostics. */
  describe() {
    return {
      projectRoot: this.projectRoot,
      state: this.state,
      pid: this.pid ?? null,
      refs: this.refs,
      version: this.deps.version,
      packageSpec: this.deps.packageSpec,
      tools: this.toolList.map((tool) => tool.name),
      lastError: this.lastError === undefined ? null : String(this.lastError?.message ?? this.lastError),
      stderrTail: this.stderrTail === '' ? null : this.stderrTail,
    }
  }
}

/**
 * A pool of project hubs keyed by project root.
 */
export class Pool {
  /**
   * @param {object} deps - Shared dependencies forwarded to every hub.
   */
  constructor(deps) {
    this.deps = deps
    /** @type {Map<string, ProjectHub>} */
    this.hubs = new Map()
  }

  /**
   * Obtain the live hub for a project root, connecting on first use.
   *
   * @param {string} projectRoot
   * @returns {Promise<ProjectHub>}
   */
  async acquire(projectRoot) {
    const existing = this.hubs.get(projectRoot)
    if (existing !== undefined && existing.state !== HUB_STATE.failed) return existing.connect()
    const hub = new ProjectHub({ projectRoot, deps: this.deps })
    this.hubs.set(projectRoot, hub)
    try {
      return await hub.connect()
    } catch (error) {
      hub.lastError = error
      this.hubs.delete(projectRoot)
      // Close rather than stop at a dead-but-open hub: `close()` also clears the connect
      // promise so a later acquire starts a genuinely new attempt.
      await hub.close().catch(() => {})
      throw error
    }
  }

  /**
   * Drop one live agent from a project. Closes the connection at zero references.
   *
   * @param {string} projectRoot
   * @returns {Promise<void>}
   */
  async release(projectRoot) {
    const hub = this.hubs.get(projectRoot)
    if (hub === undefined) return
    const refs = hub.release()
    this.deps.logger.debug(`released CodeGraph for ${projectRoot} (${refs} session(s) left)`)
    if (refs > 0) return
    this.hubs.delete(projectRoot)
    await hub.close()
    this.deps.logger.info(`stopped CodeGraph MCP server for ${projectRoot}`)
  }

  /** The hub for a project root, when one is live. */
  get(projectRoot) {
    return this.hubs.get(projectRoot)
  }

  /** Every live hub, for diagnostics and shutdown. */
  list() {
    return [...this.hubs.values()]
  }

  /** Close every hub. Idempotent; used by plugin teardown. */
  async closeAll() {
    const hubs = [...this.hubs.values()]
    this.hubs.clear()
    await Promise.allSettled(hubs.map((hub) => hub.close()))
  }
}

/**
 * Pull a human-readable failure out of an MCP error result.
 *
 * @param {object} result
 * @param {string} rawName
 * @returns {string}
 */
export function extractErrorText(result, rawName) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  const text = blocks
    .filter((block) => block !== null && typeof block === 'object' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text === '' ? `codegraph tool "${rawName}" reported an error` : text
}

/**
 * Whether an error means the connection is gone rather than the call being refused.
 *
 * The MCP SDK reports a dead stdio session as a plain `Error: Not connected`, and the
 * underlying transport can surface a closed stream or a broken pipe; anything else (a
 * server-reported tool error, a cancelled request) must reach the caller unchanged.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isConnectionLoss(error) {
  const message = String(error?.message ?? error)
  return /not connected|connection closed|closed|EPIPE|ECONNRESET|socket|terminated|write after end/i.test(message)
}

export { CodegraphStartupError, CodegraphConnectionError, describeOutcome }
