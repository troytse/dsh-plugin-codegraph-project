/**
 * Index resolution: the state matrix that decides whether a session gets CodeGraph at all.
 *
 * Each case mirrors a real filesystem shape: an indexed project, a monorepo subdirectory,
 * the CLI's own `~/.codegraph` home-directory shape (a `.codegraph/` with no database), a
 * repository boundary, and a workspace that does not exist.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INDEX_DB_SUFFIX, INDEX_DIR, isIndexed, locateIndex, protectedHomes, protectedReason } from '../lib/locate.js'

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

test('an index AT the home directory is refused, and the refusal is named', (t) => {
  // This is the failure the rule exists for: a single `~/.codegraph/codegraph.db` — however it
  // got there — would otherwise become the project of EVERY session under $HOME, offering a
  // tool for a codebase the user never indexed.
  const base = scratch(t)
  const home = join(base, 'fake-home')
  makeIndexDir(home, ['codegraph.db'])
  const nested = join(home, 'work', 'notes')
  mkdirSync(nested, { recursive: true })
  const homes = new Set([home])

  assert.equal(locateIndex(home, { protectedHomes: homes }).state, 'not-a-project')
  assert.equal(locateIndex(home, { protectedHomes: homes }).stopReason, 'home-directory')
  // A workspace that would INHERIT the home index is refused too.
  const inherited = locateIndex(nested, { protectedHomes: homes })
  assert.equal(inherited.state, 'not-a-project')
  assert.equal(inherited.stopReason, 'home-directory')
})

test('a real project nested under the home directory keeps its own index', (t) => {
  // The refusal is exact-match on the project root, not a ban on the whole subtree: a project
  // under $HOME is served by its own index like any other.
  const base = scratch(t)
  const home = join(base, 'fake-home')
  makeIndexDir(home, ['codegraph.db'])
  const project = join(home, 'work', 'api')
  makeIndexDir(project, ['codegraph.db'])
  const location = locateIndex(project, { protectedHomes: new Set([home]) })
  assert.equal(location.state, 'indexed')
  assert.equal(location.projectRoot, project)
})

test('allowHomeProject mirrors the CLI --force and serves the home index', (t) => {
  const base = scratch(t)
  const home = join(base, 'fake-home')
  makeIndexDir(home, ['codegraph.db'])
  const nested = join(home, 'work')
  mkdirSync(nested, { recursive: true })
  const homes = new Set([home])

  const atHome = locateIndex(home, { protectedHomes: homes, allowHomeProject: true })
  assert.equal(atHome.state, 'indexed')
  assert.equal(atHome.projectRoot, home)
  const inherited = locateIndex(nested, { protectedHomes: homes, allowHomeProject: true })
  assert.equal(inherited.state, 'indexed')
  assert.equal(inherited.projectRoot, home)
  // Without the flag the very same tree is refused, so the flag — not the shape — decides.
  assert.equal(locateIndex(home, { protectedHomes: homes }).state, 'not-a-project')
})

test('the filesystem root is refused as a project, with its own reason', () => {
  // `locateIndex` reports what the WALK found: starting at `/` with no index there ends as
  // `missing`. The refusal for `/` is the guard's job (exact-match on the resolved root), which
  // is what `protectedReason` answers — so a root that somehow gained an index is still refused.
  assert.deepEqual(locateIndex('/'), { state: 'missing', searchedFrom: '/', stopReason: 'filesystem-root' })
  assert.equal(protectedReason('/', new Set()), 'filesystem-root')
  assert.equal(protectedReason('/tmp', new Set()), undefined)
  assert.equal(protectedReason('/Users/troy', new Set(['/Users/troy'])), 'home-directory')
  // Exact match only: a child of the home directory is not itself the home directory.
  assert.equal(protectedReason('/Users/troy/work', new Set(['/Users/troy'])), undefined)
})

test('protectedHomes is the home directory and never a filesystem root', () => {
  const homes = protectedHomes({ HOME: '/', USERPROFILE: '/' })
  // A container that runs with HOME=/ must not report a home-directory refusal for everything;
  // the root is refused by its own rule instead.
  assert.equal(homes.has('/'), false)
  assert.equal(protectedReason('/', homes), 'filesystem-root')
})

test('a home directory shaped like the CLI runtime directory is not a project', (t) => {
  // `~/.codegraph` holding ONLY the CLI's runtime files (no database) is the common shape and
  // must never be mistaken for an index.
  const base = scratch(t)
  const home = join(base, 'fake-home')
  makeIndexDir(home, ['daemon.sock', 'daemon.log', 'codegraph.lock', 'telemetry.json'])
  const location = locateIndex(home, { protectedHomes: new Set([home]) })
  assert.equal(location.state, 'not-a-project')
  assert.equal(location.stopReason, 'empty-index')
})

test('a symlink that resolves to the home directory is refused too', (t) => {
  // macOS `/tmp` is itself a symlink to `/private/tmp`, and a session's cwd can be a link, so a
  // raw string comparison would let the identical directory through one spelling and refuse it
  // under another — the exact hole the rule exists to close.
  const base = scratch(t)
  const home = join(base, 'fake-home')
  makeIndexDir(home, ['codegraph.db'])
  const link = join(base, 'link-to-home')
  try {
    symlinkSync(home, link)
  } catch {
    t.skip('symlinks unavailable on this platform')
    return
  }
  const homes = new Set([home])
  const viaLink = locateIndex(link, { protectedHomes: homes })
  assert.equal(viaLink.state, 'not-a-project')
  assert.equal(viaLink.stopReason, 'home-directory')
  // And the same link still resolves a real project nested inside.
  const project = join(home, 'work', 'api')
  makeIndexDir(project, ['codegraph.db'])
  const linkToProject = join(base, 'link-to-project')
  symlinkSync(project, linkToProject)
  assert.equal(locateIndex(linkToProject, { protectedHomes: homes }).state, 'indexed')
})
