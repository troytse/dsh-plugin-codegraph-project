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
 * @returns {PollOutcome}
 */
export function pollTick(options) {
  const location = locateIndex(options.workspaceDir)
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
   * @param {(location: import('./locate.js').IndexLocation) => void} options.onIndexed
   * @param {(location: import('./locate.js').IndexLocation) => void} [options.onExpired]
   * @param {(error: unknown) => void} [options.onError]
   */
  constructor(options) {
    this.workspaceDir = options.workspaceDir
    this.intervalMs = options.intervalMs
    this.maxMs = options.maxMs
    this.onIndexed = options.onIndexed
    this.onExpired = options.onExpired
    this.onError = options.onError
    this.startedAt = Date.now()
    this.timer = undefined
    this.stopped = false
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
        })
      } catch (error) {
        this.onError?.(error)
        this.#schedule()
        return
      }
      if (outcome.status === 'ready') {
        this.stop()
        this.onIndexed?.(outcome.location)
        return
      }
      if (outcome.status === 'expired') {
        this.stop()
        this.onExpired?.(outcome.location)
        return
      }
      this.#schedule()
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
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
      onIndexed: (location) => {
        this.watchers.delete(workspaceDir)
        this.defaults.onIndexed(workspaceDir, location)
      },
      onExpired: (location) => {
        this.watchers.delete(workspaceDir)
        this.defaults.onExpired?.(workspaceDir, location)
      },
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
