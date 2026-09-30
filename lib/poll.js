/**
 * Watching an unindexed workspace for an index that appears later.
 *
 * The plugin never creates an index — indexing a project is the user's decision, as
 * upstream insists. What it does own is the follow-up: a session that runs
 * `codegraph init` (or that simply sits in a project someone else indexes) must get the
 * CodeGraph tools without restarting anything. Since no filesystem event reliably covers
 * "a database appeared inside a `.codegraph/` directory at or above this workspace", this
 * watcher re-runs the same resolution the mount path uses, on an interval, and reports the
 * first transition into `indexed`.
 *
 * The tick itself is a pure function so the policy (what counts as ready, when to give up)
 * is testable without timers or a filesystem.
 *
 * @module dsh-plugin-codegraph-project/poll
 */

import { isIndexed, locateIndex } from './locate.js'

/**
 * @typedef {object} PollOutcome
 * @property {'ready'|'waiting'|'expired'} status
 * @property {import('./locate.js').IndexLocation} location
 */

/**
 * One polling decision for a workspace.
 *
 * @param {object} options
 * @param {string} options.workspaceDir - Session workspace directory being watched.
 * @param {number} options.startedAt - Epoch ms when this watcher began.
 * @param {number} options.now - Epoch ms of this tick.
 * @param {number} options.maxMs - Give-up horizon; 0 means never.
 * @param {boolean} [options.allowHomeProject] - Must be threaded through from the same
 *   configuration the mount path reads. Without it the watcher and the mount path disagree
 *   whenever the index does not exist yet at session start, and a deployment that set the flag
 *   would wait forever on a home index that appeared later.
 * @returns {PollOutcome}
 */
export function pollTick(options) {
  const location = locateIndex(options.workspaceDir, { allowHomeProject: options.allowHomeProject === true })
  if (isIndexed(location)) return { status: 'ready', location }
  if (options.maxMs > 0 && options.now - options.startedAt >= options.maxMs) return { status: 'expired', location }
  return { status: 'waiting', location }
}

/**
 * A single workspace's watcher. Created per workspace directory (not per session), so any
 * number of sessions waiting on the same directory share one timer.
 */
export class IndexWatcher {
  /**
   * @param {object} options
   * @param {string} options.workspaceDir
   * @param {number} options.intervalMs
   * @param {number} options.maxMs
   * @param {() => boolean} [options.allowHomeProject] - Read per tick, like the other settings,
   *   so a settings change applies to a watcher that is already running.
   * @param {(location: import('./locate.js').IndexLocation) => void} options.onIndexed
   * @param {(location: import('./locate.js').IndexLocation) => void} [options.onExpired]
   * @param {(location: import('./locate.js').IndexLocation) => void} [options.onTick] - Called on
   *   EVERY resolved tick, not only on transitions, so an owner can keep cached per-workspace
   *   state in step with what the filesystem currently says (the index can become readable, or
   *   disappear, without ever reaching `onIndexed`/`onExpired`).
   * @param {(error: unknown) => void} [options.onError] - Called once per distinct failure
   *   reason, not once per tick. A failure may be an unreadable `.codegraph/` reported by
   *   `pollTick` (`location.stopReason === 'index-unreadable'`) or an unexpected throw; either
   *   way the wait is bounded by `maxMs`, after which the watcher stops and reports `onExpired`
   *   with the failing location.
   */
  constructor(options) {
    this.workspaceDir = options.workspaceDir
    this.intervalMs = options.intervalMs
    this.maxMs = options.maxMs
    this.allowHomeProject = options.allowHomeProject ?? (() => false)
    this.onIndexed = options.onIndexed
    this.onExpired = options.onExpired
    this.onTick = options.onTick
    this.onError = options.onError
    this.startedAt = Date.now()
    this.timer = undefined
    this.stopped = false
    /** Last failure reason already reported; a repeated tick must not re-log it. */
    this.lastError = undefined
  }

  /** Begin polling. The first tick runs after one interval, not immediately. */
  start() {
    if (this.timer !== undefined || this.stopped) return
    this.#schedule()
  }

  /** Stop polling. Idempotent. */
  stop() {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Whether this watcher is still polling. */
  get active() {
    return !this.stopped && this.timer !== undefined
  }

  #schedule() {
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      let outcome
      try {
        outcome = pollTick({
          workspaceDir: this.workspaceDir,
          startedAt: this.startedAt,
          now: Date.now(),
          maxMs: this.maxMs,
          allowHomeProject: this.allowHomeProject(),
        })
      } catch (error) {
        // A genuinely unexpected throw. `locateIndex` reports filesystem failures as a
        // location instead of throwing, so this is the safety net; it is bounded and
        // deduplicated exactly like the `index-unreadable` outcome below.
        const message = String(error?.message ?? error)
        this.#reportFailure(message, error)
        if (this.#horizonPassed()) {
          this.stop()
          this.onExpired?.({
            state: 'not-a-project',
            searchedFrom: this.workspaceDir,
            stopReason: 'watcher-error',
            error: message,
          })
          return
        }
        this.#schedule()
        return
      }
      // Let the owner observe every resolved location, not just transitions: the session layer
      // uses this to keep its cached "unreadable" diagnosis in step with reality.
      this.onTick?.(outcome.location)
      // An unreadable `.codegraph/` is the REAL failure path (a permission error or a broken
      // link), and it arrives here as a plain `not-a-project`/`index-unreadable` location, not
      // as a throw. Report it once per distinct reason, and do NOT reset the dedup key.
      if (outcome.location?.stopReason === 'index-unreadable') {
        const message = String(outcome.location.error ?? 'unreadable CodeGraph index')
        this.#reportFailure(message, new Error(message))
      } else {
        // Any other outcome is a clean read of the filesystem: a failure that recurs after it
        // is a NEW failure and must be reported again rather than suppressed forever.
        this.lastError = undefined
      }
      if (outcome.status === 'ready') {
        this.stop()
        this.onIndexed?.(outcome.location)
        return
      }
      if (outcome.status === 'expired') {
        // Bounded by the same horizon as any other wait; `outcome.location` carries
        // `stopReason: 'index-unreadable'` and `error` for the caller's give-up message.
        this.stop()
        this.onExpired?.(outcome.location)
        return
      }
      this.#schedule()
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Report a failure reason, unless it is the one already reported. */
  #reportFailure(message, error) {
    if (message === this.lastError) return
    this.lastError = message
    this.onError?.(error)
  }

  /** Whether this watcher has outlived its give-up horizon. */
  #horizonPassed() {
    return this.maxMs > 0 && Date.now() - this.startedAt >= this.maxMs
  }
}

/**
 * A registry of watchers keyed by workspace directory.
 */
export class IndexWatcherRegistry {
  /**
   * @param {object} defaults - intervalMs, maxMs, onIndexed, onExpired.
   */
  constructor(defaults) {
    this.defaults = defaults
    /** @type {Map<string, IndexWatcher>} */
    this.watchers = new Map()
  }

  /**
   * Ensure exactly one watcher exists for a workspace directory.
   *
   * @param {string} workspaceDir
   * @returns {IndexWatcher}
   */
  ensure(workspaceDir) {
    const existing = this.watchers.get(workspaceDir)
    if (existing !== undefined) return existing
    const watcher = new IndexWatcher({
      workspaceDir,
      intervalMs: this.defaults.intervalMs,
      maxMs: this.defaults.maxMs,
      // A READER, not a snapshot: the registry outlives any single settings value.
      allowHomeProject: this.defaults.allowHomeProject,
      onIndexed: (location) => {
        this.watchers.delete(workspaceDir)
        this.defaults.onIndexed(workspaceDir, location)
      },
      onExpired: (location) => {
        this.watchers.delete(workspaceDir)
        this.defaults.onExpired?.(workspaceDir, location)
      },
      onTick: this.defaults.onTick === undefined ? undefined : (location) => this.defaults.onTick(workspaceDir, location),
      onError: this.defaults.onError,
    })
    this.watchers.set(workspaceDir, watcher)
    watcher.start()
    return watcher
  }

  /**
   * Stop watching a workspace directory, when nothing is waiting on it any more.
   *
   * @param {string} workspaceDir
   */
  drop(workspaceDir) {
    const watcher = this.watchers.get(workspaceDir)
    if (watcher === undefined) return
    this.watchers.delete(workspaceDir)
    watcher.stop()
  }

  /** Stop every watcher. */
  stopAll() {
    for (const watcher of this.watchers.values()) watcher.stop()
    this.watchers.clear()
  }
}
