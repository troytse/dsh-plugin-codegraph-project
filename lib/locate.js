/**
 * Project index resolution.
 *
 * CodeGraph's CLI resolves its project by walking UP from a directory looking for
 * `.codegraph/`, so the plugin must use the same rule to decide whether a session's workspace
 * can be served at all. Three details matter and none is obvious:
 *
 * 1. A `.codegraph/` directory existing is NOT proof of an index. The CLI keeps runtime data in
 *    `~/.codegraph` (`daemon.sock`, `daemon.log`, `codegraph.lock`, `telemetry*.json`), and a
 *    directory holding only those must not be mistaken for a project. A real index is a `*.db`
 *    inside it; matching by suffix rather than a hard-coded `codegraph.db` survives an upstream
 *    rename, and the `-wal`/`-shm` siblings do not match.
 *
 *    `~/.codegraph` can ALSO be a genuine index of the home directory: it is the CLI's own
 *    runtime directory *and* where `codegraph init --force -- ~` writes `codegraph.db`. Those
 *    two shapes are indistinguishable by content, which is why rule 3 exists.
 * 2. The first `.codegraph/` found is the CLI's own stopping point: with a database it is the
 *    project root, without one the path is not a project at all — so the walk stops there
 *    instead of continuing to an ancestor that happens to have an index.
 * 3. The home directory and the filesystem root are never projects, even when they hold a real
 *    index. The CLI refuses to initialize them without an explicit `--force` ("it looks like
 *    your home directory"), and without the same refusal a single `~/.codegraph/codegraph.db` —
 *    however it got there — would silently become the project of EVERY session under `$HOME`,
 *    offering a tool for a codebase the user never indexed. `allowHomeProject: true` is this
 *    plugin's equivalent of that `--force`.
 *
 *    The refusal is deliberately checked AFTER the walk finds a root, not at every step: a real
 *    project nested at `$HOME/work/api` is still served by its own index. Only an index that
 *    would BE the home directory (or the filesystem root) is refused.
 *
 * The walk also stops at a git root, because an index above the repository boundary belongs to
 * a different repository and must not be claimed by this workspace.
 *
 * @module dsh-plugin-codegraph-project/locate
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

/** Index directory name, as agreed with the CodeGraph CLI. */
export const INDEX_DIR = '.codegraph'

/** Index database suffix (`codegraph.db` plus its `-wal`/`-shm` siblings do not match). */
export const INDEX_DB_SUFFIX = '.db'

/**
 * @typedef {object} IndexLocation
 * @property {'indexed'|'not-a-project'|'missing'|'no-cwd'} state
 * @property {string} [projectRoot] Absolute project root, present only for `indexed`.
 * @property {string} [searchedFrom] Absolute directory the walk started at.
 * @property {string} [stopReason] Why the walk ended: `index`, `empty-index`, `git-root`,
 *   `filesystem-root`, `home-directory`.
 * @property {string} [indexRoot] The directory that held the index, when one was found. For a
 *   refused location this is the root that was refused — which is usually NOT the queried
 *   workspace, so callers reporting a refusal must name this rather than the workspace.
 */

/**
 * The home directories that can never be a project, keyed the same way the walk compares paths.
 *
 * A home directory that IS a filesystem root (some containers run with `HOME=/`) is skipped: the
 * root is refused anyway through the explicit root check, and listing it twice would only make
 * the reported reason ambiguous.
 *
 * @param {NodeJS.ProcessEnv} [env] - Environment to read the home fallback from.
 * @returns {Set<string>} Resolved home directories.
 */
export function protectedHomes(env = process.env) {
  const homes = new Set()
  for (const candidate of [homedir(), env.HOME, env.USERPROFILE]) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const resolved = resolve(candidate)
    if (resolved === parse(resolved).root) continue
    homes.add(resolved)
  }
  return homes
}

/**
 * Canonicalize a directory for comparison, tolerating a path that does not exist.
 *
 * Symlinks matter here rather than being a nicety: on macOS `/tmp` IS a symlink to
 * `/private/tmp`, and a session's `cwd` can be a link to the home directory. Comparing raw
 * `resolve()` results would let a symlinked home slip past the guard while the identical real
 * path was refused, which is exactly the hole the guard exists to close.
 *
 * @param {string} value
 * @returns {string}
 */
function canonical(value) {
  const resolved = resolve(value)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

/**
 * Why a resolved project root must not be served, or `undefined` when it may be.
 *
 * @param {string} root - The project root the walk resolved.
 * @param {Set<string>} homes - From {@link protectedHomes}.
 * @returns {'filesystem-root'|'home-directory'|undefined}
 */
export function protectedReason(root, homes) {
  const resolved = canonical(root)
  if (resolved === parse(resolved).root) return 'filesystem-root'
  for (const home of homes) {
    // Exact match only: the home directory itself is refused, while a real project nested
    // under it (`$HOME/work/api`) keeps its own index and is served normally.
    if (resolved === canonical(home)) return 'home-directory'
  }
  return undefined
}

/**
 * Resolve the CodeGraph project containing `cwd`.
 *
 * @param {string | undefined} cwd - Absolute session workspace directory.
 * @param {object} [options]
 * @param {Set<string>} [options.protectedHomes] - Home directories that never count as a project.
 *   Defaults to {@link protectedHomes}.
 * @param {boolean} [options.allowHomeProject] - Mirror of the CLI's `--force`: when true, an index
 *   at the home directory is served like any other.
 * @returns {IndexLocation}
 */
export function locateIndex(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd === '') return { state: 'no-cwd' }
  const homes = options.protectedHomes ?? protectedHomes()
  const allowHomeProject = options.allowHomeProject === true
  let current = resolve(cwd)

  for (;;) {
    let entries
    try {
      entries = readdirSync(join(current, INDEX_DIR))
    } catch {
      entries = undefined
    }
    if (entries !== undefined) {
      if (!entries.some((name) => name.endsWith(INDEX_DB_SUFFIX))) {
        return { state: 'not-a-project', searchedFrom: cwd, stopReason: 'empty-index' }
      }
      // This IS the project root. Refuse it only if serving it would mean serving the home
      // directory or the filesystem root; otherwise the index is a normal project's.
      const reason = allowHomeProject ? undefined : protectedReason(current, homes)
      if (reason !== undefined) {
        return { state: 'not-a-project', searchedFrom: cwd, stopReason: reason, indexRoot: current }
      }
      return { state: 'indexed', projectRoot: current, searchedFrom: cwd, stopReason: 'index' }
    }
    if (existsSync(join(current, '.git'))) {
      return { state: 'missing', searchedFrom: cwd, stopReason: 'git-root' }
    }
    const parent = dirname(current)
    if (parent === current) {
      return { state: 'missing', searchedFrom: cwd, stopReason: 'filesystem-root' }
    }
    current = parent
  }
}

/**
 * Whether a location is servable by CodeGraph.
 *
 * @param {IndexLocation} location
 * @returns {boolean}
 */
export function isIndexed(location) {
  return location.state === 'indexed' && typeof location.projectRoot === 'string'
}
