/**
 * Project index resolution.
 *
 * CodeGraph's CLI resolves its project by walking UP from a directory looking for
 * `.codegraph/`, so the plugin must use the same rule to decide whether a session's
 * workspace can be served at all. Two details matter and neither is obvious:
 *
 * 1. A `.codegraph/` directory existing is NOT proof of an index. The CLI keeps its own
 *    installation data in `~/.codegraph` (`current -> versions/<v>`, `bundles/`,
 *    `codegraph.lock` and no database), so a home-directory-shaped `.codegraph/` would
 *    otherwise be mistaken for an indexed project and every tool call would come back
 *    with "No CodeGraph project is loaded". A real index is a `*.db` inside it; matching
 *    by suffix rather than a hard-coded `codegraph.db` survives an upstream rename, and
 *    the `-wal`/`-shm` siblings do not match.
 * 2. The first `.codegraph/` found is the CLI's own stopping point: with a database it is
 *    the project root, without one the path is not a project at all — so the walk stops
 *    there instead of continuing to an ancestor that happens to have an index.
 *
 * The walk also stops at a git root, because an index above the repository boundary
 * belongs to a different repository and must not be claimed by this workspace.
 *
 * @module dsh-plugin-codegraph-project/locate
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Index directory name, as agreed with the CodeGraph CLI. */
export const INDEX_DIR = '.codegraph'

/** Index database suffix (`codegraph.db` plus its `-wal`/`-shm` siblings do not match). */
export const INDEX_DB_SUFFIX = '.db'

/**
 * @typedef {object} IndexLocation
 * @property {'indexed'|'not-a-project'|'missing'|'no-cwd'} state
 * @property {string} [projectRoot] Absolute project root, present only for `indexed`.
 * @property {string} [searchedFrom] Absolute directory the walk started at.
 * @property {string} [stopReason] Why the walk ended: `index`, `empty-index`, `git-root`, `filesystem-root`.
 */

/**
 * Resolve the CodeGraph project containing `cwd`.
 *
 * @param {string | undefined} cwd - Absolute session workspace directory.
 * @returns {IndexLocation}
 */
export function locateIndex(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return { state: 'no-cwd' }
  let current = cwd
  for (;;) {
    let entries
    try {
      entries = readdirSync(join(current, INDEX_DIR))
    } catch {
      entries = undefined
    }
    if (entries !== undefined) {
      if (entries.some((name) => name.endsWith(INDEX_DB_SUFFIX))) {
        return { state: 'indexed', projectRoot: current, searchedFrom: cwd, stopReason: 'index' }
      }
      return { state: 'not-a-project', searchedFrom: cwd, stopReason: 'empty-index' }
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
