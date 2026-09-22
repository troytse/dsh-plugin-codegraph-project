/**
 * dsh-plugin-codegraph-project — project-scoped CodeGraph for DeepSeek Harness.
 *
 * Every session's workspace is resolved to a CodeGraph project root; a project is served by
 * ONE CodeGraph MCP server launched through npx (owned by the harness's managed-subprocess
 * service) and shared by reference count across every session working in it; a session whose
 * project has no index is refused at the tool boundary until an index appears, at which point
 * the refusal lifts without restarting anything.
 *
 * No service is provided and no user file is written. Tool definitions are registered on the
 * root registry — see `agent-tools.js` for the measurement showing why DSH cannot deliver a
 * per-session tool list — and per-session gating is enforced by guards registered on each
 * agent's own context plus a per-session prompt section.
 *
 * @module dsh-plugin-codegraph-project
 */

import { mkdirSync } from 'node:fs'
import { Config as RowConfig, SettingsSchema, SETTINGS_NAMESPACE, packageSpecFor, resolveEffective, validateConfig } from './config.js'
import { isIndexed, locateIndex } from './locate.js'
import { Pool } from './pool.js'
import { IndexWatcherRegistry } from './poll.js'
import { ToolAggregate, registerSessionGuard } from './agent-tools.js'

/** Namespace plugin name used by loader diagnostics. */
export const name = 'codegraph-project'

/**
 * Public configuration schema. Cordis reads a plugin's `Config` export to validate and default
 * the row's `config:` block, so this is the name that must be exported.
 */
export { RowConfig as Config }

/**
 * The subprocess service is a hard dependency: without it a CodeGraph child would not be a
 * managed process, and refusing to activate is strictly better than spawning something that
 * can outlive the harness.
 */
export const inject = ['subprocess']

/** Order for the prompt section, alongside the other plugin sections. */
const PROMPT_SECTION_ORDER = 152

/** Activation-time CLI probe timeout: a cold bundle download is the slow case. */
const CLI_PROBE_TIMEOUT_MS = 300_000

/** Default npm cache used when the row configuration does not name one. */
const DEFAULT_CACHE_SUBDIR = 'codegraph/npm-cache'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {object} config - Row configuration, already schema-resolved.
 */
export function apply(ctx, config) {
  const logger = makeLogger(ctx, name)
  const validation = validateConfig(config)
  if (!validation.ok) {
    for (const message of validation.errors) logger.error(`invalid configuration: ${message}`)
    throw new Error(`codegraph-project: invalid configuration (${validation.errors.join('; ')})`)
  }
  if (!config.enabled) {
    logger.info('disabled by configuration; no CodeGraph server will be started')
    return
  }

  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    // Unreachable while `inject` is honored; kept so a host that drops the service fails
    // loudly instead of silently spawning an unmanaged process.
    logger.error('the subprocess service is unavailable; refusing to start CodeGraph outside harness process ownership')
    return
  }

  /** User settings layer, when the settings service supports registration. */
  let settingsScope
  const settingsService = ctx.get('settings')
  if (settingsService !== undefined && typeof settingsService.register === 'function') {
    const base = {
      enabled: config.enabled,
      version: config.version,
      packageSpec: config.packageSpec,
      cacheDir: config.cacheDir,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
    }
    try {
      settingsScope = settingsService.register(SETTINGS_NAMESPACE, SettingsSchema, { base, applies: 'live' })
    } catch (error) {
      logger.warn(`could not register the "${SETTINGS_NAMESPACE}" settings namespace (${String(error?.message ?? error)}); row configuration stays authoritative`)
    }
  }

  /**
   * Configuration in effect right now: row config with any valid user overrides applied. A
   * user layer that fails validation is refused and the row config stays in force, so a bad
   * settings edit can never disable or mis-launch the plugin silently.
   */
  function effectiveConfig() {
    let user
    try {
      user = typeof settingsScope?.get === 'function' ? settingsScope.get() : undefined
    } catch (error) {
      logger.warn(`reading the "${SETTINGS_NAMESPACE}" settings failed (${String(error?.message ?? error)}); row configuration stays authoritative`)
      user = undefined
    }
    const merged = resolveEffective(config, user)
    const check = validateConfig(merged)
    if (!check.ok) {
      logger.error(`ignoring an invalid "${SETTINGS_NAMESPACE}" override (${check.errors.join('; ')})`)
      return config
    }
    return merged
  }

  /** Resolve and create the npx cache directory for the current configuration. */
  function currentCacheDir() {
    const configured = effectiveConfig().cacheDir
    const dir = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : defaultCacheDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      logger.warn(`could not create the npx cache directory ${dir} (${String(error?.message ?? error)}); npx may fail`)
    }
    return dir
  }

  const initial = effectiveConfig()
  const deps = {
    subprocess,
    logger,
    graceMs: 3_000,
    startupTimeoutMs: 180_000,
    // Read through the current settings on every use, so a version or timeout change applies
    // to the next project connection without a reload.
    get serverName() { return effectiveConfig().serverName },
    get version() { return effectiveConfig().version },
    get packageSpec() {
      const current = effectiveConfig()
      return packageSpecFor(current.packageSpec, current.version)
    },
    get toolCallTimeoutMs() { return effectiveConfig().toolCallTimeoutMs },
    get env() { return buildChildEnv(effectiveConfig(), currentCacheDir()) },
  }
  // Test seam: a deployment never sets this, but a test can substitute the launched program
  // while every other path (client, transport, registration) stays production.
  if (typeof config.argvBuilder === 'function') deps.argvBuilder = config.argvBuilder
  const pool = new Pool(deps)

  const tools = ctx.get('tools')
  const aggregate = tools === undefined ? undefined : new ToolAggregate({ tools, logger })

  /** Live sessions and their decisions, keyed by agent id. */
  const sessions = new Map()

  // One guard for the whole process: it owns every CodeGraph tool name and decides per call
  // using the calling agent's own session record. See `registerSessionGuard` for why a
  // per-agent guard is not reachable from a plugin.
  if (aggregate !== undefined && tools !== undefined && typeof tools.guard === 'function') {
    ctx.effect(() => registerSessionGuard({
      tools,
      gatedNames: () => aggregate.names(),
      mayCall: (agentId) => agentId !== undefined && sessions.get(agentId)?.state === 'mounted',
      reason: (agentId) => {
        const session = agentId === undefined ? undefined : sessions.get(agentId)
        return session === undefined
          ? 'CodeGraph is not enabled for this session.'
          : mountRefusal(session, effectiveConfig())
      },
    }), 'codegraph-project: session guard')
  }

  /** Sessions waiting for an index, keyed by workspace directory. */
  const waitingByWorkspace = new Map()

  const watchers = new IndexWatcherRegistry({
    // Read per watcher creation, so a settings change applies to the next workspace watched.
    get intervalMs() { return effectiveConfig().pollIntervalMs },
    get maxMs() { return effectiveConfig().pollMaxMs },
    allowHomeProject: () => effectiveConfig().allowHomeProject,
    onIndexed: (workspaceDir, location) => {
      const waiting = waitingByWorkspace.get(workspaceDir)
      waitingByWorkspace.delete(workspaceDir)
      if (waiting === undefined || waiting.size === 0 || !isIndexed(location)) return
      logger.info(`CodeGraph index detected at ${location.projectRoot}; enabling ${waiting.size} waiting session(s)`)
      for (const session of waiting.values()) void mountSession(session, location.projectRoot, 'index-detected')
    },
    onExpired: (workspaceDir) => {
      const waiting = waitingByWorkspace.get(workspaceDir)
      waitingByWorkspace.delete(workspaceDir)
      for (const session of waiting?.values() ?? []) session.state = 'waiting-expired'
      logger.info(`stopped watching ${workspaceDir} for a CodeGraph index (pollMaxMs elapsed)`)
    },
    onError: (error) => logger.warn(`CodeGraph index watcher failed: ${String(error?.message ?? error)}`),
  })

  // ---------------------------------------------------------------------------------
  // Per-agent orchestration
  // ---------------------------------------------------------------------------------

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    // Deliberately not awaited: `agent/created` listeners are dispatched synchronously and the
    // harness does not await them, so a cold npx download can never delay a session from
    // becoming usable. The guard is installed synchronously, before any model step.
    handleAgentCreated(agent)
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    void handleAgentDisposed(agent)
  })

  /**
   * Every session gets a guard and a decision, but only an indexed workspace gets a project
   * connection. The guard re-derives its answer at call time so an index that appears later
   * needs no re-registration.
   */
  function handleAgentCreated(agent) {
    const agentCtx = agent.ctx
    if (agentCtx === undefined) {
      logger.warn(`session ${String(agent.id)} has no agent context; CodeGraph is unavailable for it`)
      return
    }
    const session = {
      id: String(agent.id),
      workspaceDir: agent.session?.header?.cwd,
      projectRoot: undefined,
      refusedRoot: undefined,
      state: 'undecided',
      uninstall: undefined,
      release: undefined,
    }
    sessions.set(session.id, session)


    const current = effectiveConfig()
    const location = locateIndex(session.workspaceDir, { allowHomeProject: current.allowHomeProject })
    if (!isIndexed(location)) {
      // A home-directory refusal is terminal: polling will not change it, because the walk
      // refuses before it looks for an index. Recording it as its own state keeps the guard
      // message (and the diagnostic tool) honest about why nothing is served here.
      session.state = location.state === 'no-cwd'
        ? 'no-cwd'
        : location.stopReason === 'home-directory' ? 'home-directory' : 'waiting'
      // The refused root is not the workspace (a workspace under $HOME is refused because its
      // walk resolves to $HOME), so keep it to report the true path rather than a false one.
      if (location.stopReason === 'home-directory') session.refusedRoot = location.indexRoot
      if (session.state === 'waiting') watchFor(session)
      logger.debug(`no CodeGraph index reachable from ${String(session.workspaceDir)} (${location.state}/${location.stopReason ?? 'unknown'})`)
      return
    }
    void mountSession(session, location.projectRoot, 'session-start')
  }

  /** Start watching a session's workspace for an index that does not exist yet. */
  function watchFor(session) {
    const workspaceDir = session.workspaceDir
    if (typeof workspaceDir !== 'string' || workspaceDir === '') return
    let waiting = waitingByWorkspace.get(workspaceDir)
    if (waiting === undefined) {
      waiting = new Map()
      waitingByWorkspace.set(workspaceDir, waiting)
    }
    waiting.set(session.id, session)
    watchers.ensure(workspaceDir)
  }

  /**
   * Connect the session's project (or reuse its shared instance) and register this session for
   * the aggregate's routing table.
   *
   * @param {object} session
   * @param {string} projectRoot
   * @param {string} reason
   */
  async function mountSession(session, projectRoot, reason) {
    if (session.state === 'mounted' && session.projectRoot === projectRoot) return
    let hub
    try {
      hub = await pool.acquire(projectRoot)
    } catch (error) {
      session.state = 'connect-failed'
      logger.error(`could not start CodeGraph for ${projectRoot}: ${String(error?.message ?? error)}`)
      if (typeof error?.stderrTail === 'string' && error.stderrTail !== '') {
        logger.error(`CodeGraph output: ${error.stderrTail.trim().split('\n').slice(-6).join(' | ')}`)
      }
      return
    }
    if (!sessions.has(session.id)) {
      // Disposed while connecting.
      await pool.release(projectRoot).catch(() => {})
      return
    }
    if (reason !== 'tool-set-changed') {
      session.release?.()
      session.release = undefined
    }
    if (aggregate !== undefined) {
      if (session.uninstall === undefined) session.uninstall = aggregate.retain(hub)
      aggregate.route(session.id, projectRoot)
      aggregate.setHubs(pool.hubs)
    }
    hub.retain()
    session.projectRoot = projectRoot
    session.state = 'mounted'
    logger.info(`CodeGraph ready for ${projectRoot} -> ${aggregate?.names().join(', ') || '(no tools advertised)'} (pid ${String(hub.pid ?? 'unknown')}, ${hub.refs} session(s), reason ${reason})`)
  }

  async function handleAgentDisposed(agent) {
    const id = String(agent.id)
    const session = sessions.get(id)
    sessions.delete(id)
    if (session === undefined) return
    const waiting = typeof session.workspaceDir === 'string' ? waitingByWorkspace.get(session.workspaceDir) : undefined
    if (waiting !== undefined) {
      waiting.delete(id)
      if (waiting.size === 0) {
        waitingByWorkspace.delete(session.workspaceDir)
        watchers.drop(session.workspaceDir)
      }
    }
    session.uninstall?.()
    aggregate?.unroute(id)
    if (session.projectRoot !== undefined) {
      await pool.release(session.projectRoot).catch((error) => {
        logger.warn(`releasing CodeGraph for ${session.projectRoot} failed: ${String(error?.message ?? error)}`)
      })
    }
  }

  /** The refusal a session sees when it calls CodeGraph without an indexed project. */
  function mountRefusal(session, current) {
    const workspace = typeof session.workspaceDir === 'string' && session.workspaceDir !== '' ? session.workspaceDir : 'this workspace'
    if (session.state === 'connect-failed') {
      return `CodeGraph is not available for ${workspace}: its project connection failed to start. See the dsh logs (plugin "codegraph-project") for the captured error, or ask the user to check the CodeGraph version/cache configuration.`
    }
    if (session.state === 'home-directory') {
      const root = typeof session.refusedRoot === 'string' && session.refusedRoot !== '' ? session.refusedRoot : 'the home directory'
      return [
        `CodeGraph is not enabled for ${workspace}: its project is the home directory (${root}), which is never treated as a project.`,
        `An index of the home directory would be claimed by every session under it, so that index is ignored even though it exists.`,
        `Two ways forward — pick whichever matches the user's intent:`,
        `  • index the specific project and work there: npx -y @colbymchenry/codegraph@${current.version} init -y -- <project root>`,
        `  • or serve that home index deliberately: set allowHomeProject: true in this plugin's configuration (the equivalent of the CLI's --force).`,
      ].join('\n')
    }
    return [
      `CodeGraph is not enabled for ${workspace}: no CodeGraph index exists for it, so there is nothing to query.`,
      `Use the normal file tools (read/grep/glob) here.`,
      `If the user wants CodeGraph for this project, they can enable one with:`,
      `  npx -y @colbymchenry/codegraph@${current.version} init -y -- ${workspace}`,
      `Tools become usable in this session within a few seconds of the index appearing.`,
    ].join('\n')
  }

  // ---------------------------------------------------------------------------------
  // Prompt guidance: only for sessions that actually have a project connection
  // ---------------------------------------------------------------------------------

  const systemPrompt = ctx.get('systemPrompt')
  if (initial.usageGuidance && systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({
      name: 'codegraph-project',
      order: PROMPT_SECTION_ORDER,
      text: (context) => guidanceFor(context, sessions, aggregate, effectiveConfig()),
    }), 'codegraph-project: prompt section')
  }

  // ---------------------------------------------------------------------------------
  // Optional diagnostic tool
  // ---------------------------------------------------------------------------------

  if (initial.diagnosticTool && tools !== undefined && typeof tools.register === 'function') {
    ctx.effect(() => tools.register({
      name: 'codegraph_project_status',
      description: "Report this session's CodeGraph state: resolved project root, why its tools are or are not usable, the managed server pid, and every live project instance.",
      // Both schemas are written in the registry's own vocabulary: the value schema DSL has no
      // `json` shorthand (an open object is how it says "any JSON"), and an object node must
      // state its openness explicitly.
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      },
      async execute(_args, exec) {
        const current = effectiveConfig()
        const id = exec?.agent?.id === undefined ? undefined : String(exec.agent.id)
        const session = id === undefined ? undefined : sessions.get(id)
        return {
          session: session === undefined ? null : {
            state: session.state,
            workspaceDir: session.workspaceDir ?? null,
            projectRoot: session.projectRoot ?? null,
            refusedRoot: session.refusedRoot ?? null,
          },
          configuration: {
            enabled: current.enabled,
            version: current.version,
            packageSpec: packageSpecFor(current.packageSpec, current.version),
            cacheDir: currentCacheDir(),
            serverName: current.serverName,
            pollIntervalMs: current.pollIntervalMs,
            allowHomeProject: current.allowHomeProject,
          },
          registeredTools: aggregate?.names() ?? [],
          liveInstances: pool.list().map((hub) => hub.describe()),
          sessions: [...sessions.values()].map((entry) => ({ id: entry.id, state: entry.state, projectRoot: entry.projectRoot ?? null })),
          initHint: `Index this project with: npx -y @colbymchenry/codegraph@${current.version} init -y -- <project root>. Tools become usable in the running session once the index exists.`,
        }
      },
    }), 'codegraph-project: diagnostic tool')
  }

  // ---------------------------------------------------------------------------------
  // Activation-time CLI probe (diagnostics only) and teardown
  // ---------------------------------------------------------------------------------

  if (initial.cliProbe) void runCliProbe({ deps, logger })

  ctx.effect(() => () => {
    // Teardown order matters: stop timers, drop guards and registrations, then close processes
    // whose exit is awaited. The subprocess service remains the backstop it always is.
    watchers.stopAll()
    waitingByWorkspace.clear()
    for (const session of sessions.values()) session.uninstall?.()
    sessions.clear()
    void pool.closeAll()
  }, 'codegraph-project: teardown')
}

/**
 * Build the prompt section text for one assembly.
 *
 * Returns empty text unless this session is currently mounted, so the guidance only ever
 * appears where the tools are actually usable.
 *
 * @param {{ agent?: { id?: string } }} context
 * @param {Map<string, object>} sessions
 * @param {object | undefined} aggregate
 * @param {object} config
 * @returns {string}
 */
export function guidanceFor(context, sessions, aggregate, config) {
  const agentId = context?.agent?.id
  if (agentId === undefined) return ''
  const session = sessions.get(String(agentId))
  if (session?.state !== 'mounted') return ''
  const toolNames = aggregate?.names() ?? []
  if (toolNames.length === 0) return ''
  const versionNote = config?.version === undefined ? '' : ` (codegraph ${config.version})`
  return [
    '## CodeGraph: this project is indexed',
    '',
    `Project root: \`${session.projectRoot}\`${versionNote}`,
    `Tools: ${toolNames.map((tool) => `\`${tool}\``).join(', ')}`,
    'Call `codegraph_explore` with symbol or file names (or a short question) before a grep/read loop: '
      + 'one call returns the verbatim, line-numbered source of the relevant symbols plus the call path and '
      + 'blast radius. Treat the returned source as already read.',
    'A path with no CodeGraph index is served by the normal file tools; indexing a project is the user\'s decision.',
  ].join('\n')
}

/**
 * Probe `npx <spec> version` once at activation. Purely diagnostic: it warms the npm cache so
 * the first session starts faster, and it logs what a session would otherwise discover later.
 *
 * @param {{ deps: object, logger: object }} options
 */
async function runCliProbe(options) {
  const { deps, logger } = options
  try {
    const spec = deps.packageSpec
    const env = deps.env
    const { resolveNpx } = await import('./pool.js')
    const launcher = await resolveNpx(deps.subprocess, env)
    const handle = deps.subprocess.spawn({
      argv: [launcher, '-y', spec, 'version'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
      env,
    })
    const outcome = await Promise.race([
      handle.done,
      new Promise((resolve) => {
        const id = setTimeout(() => resolve(undefined), CLI_PROBE_TIMEOUT_MS)
        if (typeof id.unref === 'function') id.unref()
      }),
    ])
    if (outcome === undefined) {
      logger.warn(`CodeGraph CLI probe timed out after ${CLI_PROBE_TIMEOUT_MS}ms (${spec}); a session will retry on demand`)
      try { handle.terminate() } catch { /* already gone */ }
      return
    }
    if (outcome.exitCode === 0) logger.info(`CodeGraph CLI is runnable through npx (${spec})`)
    else logger.warn(`CodeGraph CLI probe for ${spec} ended with ${outcome.exitCode === null ? `signal ${outcome.signal}` : `code ${outcome.exitCode}`}; a session will report the real failure`)
  } catch (error) {
    logger.warn(`CodeGraph CLI probe failed (${String(error?.message ?? error)}); a session will attempt the server on demand`)
  }
}

/**
 * Default npm cache directory, under the DSH home.
 *
 * @returns {string}
 */
function defaultCacheDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : `${process.env.HOME ?? process.env.USERPROFILE ?? '.'}/.dsh`
  return `${home.replace(/[\\/]+$/, '')}/${DEFAULT_CACHE_SUBDIR}`
}

/**
 * Child environment deltas. The subprocess service merges these over the scrubbed parent
 * environment, so PATH, HOME, and proxy variables keep working.
 *
 * @param {object} config - Effective configuration.
 * @param {string} cacheDir
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv(config, cacheDir) {
  const env = {
    // Both spellings: npm reads the uppercase environment form; tools that shell out read the
    // lowercase one.
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_cache: cacheDir,
    CODEGRAPH_TELEMETRY: config.telemetry ? '1' : '0',
  }
  const pid = typeof process.pid === 'number' && Number.isSafeInteger(process.pid) && process.pid > 1 ? process.pid : undefined
  if (pid !== undefined) {
    // CodeGraph's own orphan watchdog compares this against its live ppid, which covers the
    // one case in-process cleanup cannot: the harness being killed outright.
    env.CODEGRAPH_HOST_PPID = String(pid)
  }
  return env
}

/**
 * A logger that degrades to the console when the context exposes no logger.
 *
 * @param {object} ctx
 * @param {string} tag
 */
function makeLogger(ctx, tag) {
  const logger = ctx?.logger
  return {
    info: (message) => {
      if (typeof logger?.info === 'function') logger.info(message)
      else console.log(`[${tag}] ${message}`)
    },
    debug: (message) => {
      if (typeof logger?.debug === 'function') logger.debug(message)
      else if (typeof logger?.info === 'function') logger.info(message)
    },
    warn: (message) => {
      if (typeof logger?.warn === 'function') logger.warn(message)
      else console.warn(`[${tag}] ${message}`)
    },
    error: (message) => {
      if (typeof logger?.error === 'function') logger.error(message)
      else console.error(`[${tag}] ${message}`)
    },
  }
}
