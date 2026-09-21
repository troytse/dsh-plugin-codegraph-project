/**
 * The index watcher: the mechanism behind "index a project mid-session and the tools appear
 * without restarting anything". The decision function is tested directly, and the watcher's
 * timer is tested with a real (short) interval against a real directory tree.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IndexWatcher, IndexWatcherRegistry, pollTick } from '../lib/poll.js'

/** A scratch directory removed when the test ends. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cgraph-poll-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Create an index database under a directory. */
function indexAt(root) {
  mkdirSync(join(root, '.codegraph'), { recursive: true })
  writeFileSync(join(root, '.codegraph', 'codegraph.db'), '')
}

/** Wait until a predicate holds or the deadline passes. */
async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

test('a tick reports ready as soon as an index exists', (t) => {
  const root = scratch(t)
  const waiting = pollTick({ workspaceDir: root, startedAt: Date.now(), now: Date.now(), maxMs: 0 })
  assert.equal(waiting.status, 'waiting')
  indexAt(root)
  const ready = pollTick({ workspaceDir: root, startedAt: Date.now(), now: Date.now(), maxMs: 0 })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.location.projectRoot, root)
})

test('a tick expires once the horizon passes, but never while maxMs is 0', (t) => {
  const root = scratch(t)
  const startedAt = 1_000
  assert.equal(pollTick({ workspaceDir: root, startedAt, now: startedAt + 10, maxMs: 0 }).status, 'waiting')
  assert.equal(pollTick({ workspaceDir: root, startedAt, now: startedAt + 9_999, maxMs: 10_000 }).status, 'waiting')
  assert.equal(pollTick({ workspaceDir: root, startedAt, now: startedAt + 10_000, maxMs: 10_000 }).status, 'expired')
})

test('a tick prefers readiness over expiry', (t) => {
  const root = scratch(t)
  indexAt(root)
  const outcome = pollTick({ workspaceDir: root, startedAt: 1_000, now: 999_999, maxMs: 10 })
  assert.equal(outcome.status, 'ready')
})

test('a tick finds an index created above the workspace, as a monorepo root would be', (t) => {
  const root = scratch(t)
  const nested = join(root, 'services', 'api')
  mkdirSync(nested, { recursive: true })
  indexAt(root)
  const outcome = pollTick({ workspaceDir: nested, startedAt: 1_000, now: 1_000, maxMs: 0 })
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.location.projectRoot, root)
})

test('the watcher reports an index that appears while it is running, then stops', async (t) => {
  const root = scratch(t)
  const seen = []
  const watcher = new IndexWatcher({
    workspaceDir: root,
    intervalMs: 25,
    maxMs: 0,
    onIndexed: (location) => seen.push(location),
  })
  watcher.start()
  assert.equal(watcher.active, true)
  indexAt(root)
  assert.ok(await waitFor(() => seen.length === 1))
  assert.equal(seen[0].projectRoot, root)
  assert.equal(watcher.active, false, 'a watcher stops once it has reported')
  watcher.stop()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(seen.length, 1, 'a stopped watcher reports nothing further')
})

test('the watcher expires and reports nothing when the horizon passes', async (t) => {
  const root = scratch(t)
  const indexed = []
  const expired = []
  const watcher = new IndexWatcher({
    workspaceDir: root,
    intervalMs: 20,
    maxMs: 40,
    onIndexed: (location) => indexed.push(location),
    onExpired: (location) => expired.push(location),
  })
  watcher.start()
  assert.ok(await waitFor(() => expired.length === 1))
  assert.equal(indexed.length, 0)
  assert.equal(watcher.active, false)
})

test('the registry keeps one watcher per workspace and survives a manual drop', async (t) => {
  const root = scratch(t)
  const seen = []
  const registry = new IndexWatcherRegistry({
    intervalMs: 25,
    maxMs: 0,
    onIndexed: (workspaceDir, location) => seen.push({ workspaceDir, location }),
  })
  const first = registry.ensure(root)
  const second = registry.ensure(root)
  assert.equal(first, second, 'one watcher per workspace directory')
  registry.drop(root)
  assert.equal(first.active, false)
  indexAt(root)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(seen.length, 0, 'a dropped workspace is no longer watched')
  registry.stopAll()
})

test('an index does not appear without one, and the watcher keeps waiting', async (t) => {
  const root = scratch(t)
  const seen = []
  const registry = new IndexWatcherRegistry({
    intervalMs: 20,
    maxMs: 0,
    onIndexed: (workspaceDir, location) => seen.push(location),
  })
  registry.ensure(root)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(seen.length, 0)
  // Still watching: creating the index now is still picked up.
  indexAt(root)
  assert.ok(await waitFor(() => seen.length === 1))
  registry.stopAll()
})
