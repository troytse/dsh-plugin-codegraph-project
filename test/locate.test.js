/**
 * Index resolution: the state matrix that decides whether a session gets CodeGraph at all.
 *
 * Each case mirrors a real filesystem shape: an indexed project, a monorepo subdirectory,
 * the CLI's own `~/.codegraph` home-directory shape (a `.codegraph/` with no database), a
 * repository boundary, and a workspace that does not exist.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INDEX_DB_SUFFIX, INDEX_DIR, isIndexed, locateIndex } from '../lib/locate.js'

/** Create a scratch directory that is removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cgraph-locate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Create `<root>/.codegraph/` with the given entries. */
function makeIndexDir(root, entries) {
  const indexDir = join(root, INDEX_DIR)
  mkdirSync(indexDir, { recursive: true })
  for (const entry of entries) writeFileSync(join(indexDir, entry), '')
}

test('indexed project resolves from its own directory', (t) => {
  const root = scratch(t)
  makeIndexDir(root, ['codegraph.db', '.gitignore'])
  const location = locateIndex(root)
  assert.equal(location.state, 'indexed')
  assert.equal(location.projectRoot, root)
  assert.equal(location.stopReason, 'index')
  assert.ok(isIndexed(location))
})

test('a monorepo subdirectory resolves to the repository root that holds the index', (t) => {
  const root = scratch(t)
  makeIndexDir(root, ['codegraph.db'])
  const nested = join(root, 'packages', 'app', 'src')
  mkdirSync(nested, { recursive: true })
  const location = locateIndex(nested)
  assert.equal(location.state, 'indexed')
  assert.equal(location.projectRoot, root)
  assert.equal(location.searchedFrom, nested)
})

test('a `.codegraph/` without a database is not a project, even when a parent has an index', (t) => {
  const outer = scratch(t)
  makeIndexDir(outer, ['codegraph.db'])
  const inner = join(outer, 'vendor', 'pkg')
  makeIndexDir(inner, ['cache'])
  const location = locateIndex(inner)
  assert.equal(location.state, 'not-a-project')
  assert.equal(location.stopReason, 'empty-index')
  assert.equal(isIndexed(location), false)
})

test('the CLI installation directory shape (empty `.codegraph/`) is rejected', (t) => {
  const home = scratch(t)
  makeIndexDir(home, ['current', 'codegraph.lock'])
  const location = locateIndex(home)
  assert.equal(location.state, 'not-a-project')
})

test('the walk stops at a git root instead of claiming an ancestor index', (t) => {
  const outer = scratch(t)
  makeIndexDir(outer, ['codegraph.db'])
  const repo = join(outer, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  const location = locateIndex(repo)
  assert.equal(location.state, 'missing')
  assert.equal(location.stopReason, 'git-root')
})

test('an unindexed tree with no git root reports missing at the filesystem root', (t) => {
  const root = scratch(t)
  const nested = join(root, 'a', 'b')
  mkdirSync(nested, { recursive: true })
  // The scratch path has no `.git`, so the walk reaches `/` — still a definitive `missing`.
  const location = locateIndex(nested)
  assert.equal(location.state, 'missing')
  assert.ok(['git-root', 'filesystem-root'].includes(location.stopReason))
})

test('an absent cwd is reported rather than searched', () => {
  assert.equal(locateIndex(undefined).state, 'no-cwd')
  assert.equal(locateIndex('').state, 'no-cwd')
})

test('a database anywhere among the index entries is enough, whatever it is called', (t) => {
  const root = scratch(t)
  makeIndexDir(root, ['index-v2.db'])
  assert.equal(locateIndex(root).state, 'indexed')
})

test('write-ahead log siblings do not count as a database', (t) => {
  const onlyWal = scratch(t)
  makeIndexDir(onlyWal, ['codegraph.db-wal', 'codegraph.db-shm'])
  // The suffix check is on the whole name, so `-wal`/`-shm` files must not match.
  assert.equal(INDEX_DB_SUFFIX, '.db')
  assert.equal(locateIndex(onlyWal).state, 'not-a-project')
})
