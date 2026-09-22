/**
 * Refuse JavaScript APIs newer than the oldest Node.js this package claims to support
 * (`engines.node`), because a test-only gap is still a broken CI matrix.
 *
 * This exists because the suite once used `Promise.withResolvers` (Node.js 22+) inside a test
 * helper while CI also ran Node.js 20: every publishing path was fine, every local run on a new
 * Node was fine, and only one CI leg failed. A grep is a blunt instrument, but for APIs that
 * are simply absent on an older runtime it is exact, dependency-free, and catches the mistake
 * before CI does.
 *
 * Every entry is verified against the oldest supported runtime: anything that already exists
 * there does NOT belong in this list (a false positive would block legitimate code).
 *
 * Usage: node scripts/check-node-compat.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)

/** The oldest runtime the package claims to support. */
const MIN_NODE_MAJOR = Number(/(\d+)/.exec(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node ?? '20')?.[1] ?? 20)

/** APIs absent on Node.js 20, with the release that introduced them. */
const CANDIDATES = [
  { pattern: /Promise\s*\.\s*withResolvers\s*\(/, since: 22, name: 'Promise.withResolvers' },
  { pattern: /Object\s*\.\s*groupBy\s*\(/, since: 21, name: 'Object.groupBy' },
  { pattern: /Map\s*\.\s*groupBy\s*\(/, since: 21, name: 'Map.groupBy' },
  { pattern: /Array\s*\.\s*fromAsync\s*\(/, since: 22, name: 'Array.fromAsync' },
  { pattern: /import\s*\.\s*meta\s*\.\s*dirname\b/, since: 21, name: 'import.meta.dirname' },
  { pattern: /import\s*\.\s*meta\s*\.\s*filename\b/, since: 21, name: 'import.meta.filename' },
  { pattern: /RegExp\s*\.\s*escape\s*\(/, since: 24, name: 'RegExp.escape' },
]

/** The entries that actually apply to the declared minimum. */
const TOO_NEW = CANDIDATES.filter((entry) => entry.since > MIN_NODE_MAJOR)

/** Every JavaScript file the package ships or tests with. */
function sourceFiles(root, out = []) {
  for (const name of readdirSync(root)) {
    if (name === 'node_modules' || name === '.git') continue
    const path = join(root, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(?:js|mjs)$/.test(name)) out.push(path)
  }
  return out
}

/**
 * Remove `//` and block comments so prose that NAMES an API does not count as a use of it —
 * this file's own documentation would otherwise fail the check.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const violations = []
for (const file of sourceFiles(ROOT)) {
  // This file necessarily names every banned API.
  if (file === SELF) continue
  const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
  for (const entry of TOO_NEW) {
    for (const [index, line] of lines.entries()) {
      if (!entry.pattern.test(line)) continue
      violations.push(`${file.slice(ROOT.length)}:${String(index + 1)} uses ${entry.name} (Node.js ${String(entry.since)}+)`)
    }
  }
}

if (violations.length > 0) {
  console.error(`This package supports Node.js ${String(MIN_NODE_MAJOR)}+, but:`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`No APIs newer than Node.js ${String(MIN_NODE_MAJOR)} found in the shipped and tested sources.`)
