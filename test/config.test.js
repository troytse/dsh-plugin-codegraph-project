/**
 * Configuration resolution: defaults, the user layer, and the validations that turn a typo
 * into a startup error instead of a confusing runtime failure.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CODEGRAPH_PACKAGE,
  DEFAULT_SERVER_NAME,
  DEFAULT_VERSION,
  Config,
  SettingsSchema,
  packageSpecFor,
  resolveEffective,
  validateConfig,
} from '../lib/config.js'

test('row defaults are usable with no configuration at all', () => {
  const config = new Config({})
  assert.equal(config.enabled, true)
  assert.equal(config.version, DEFAULT_VERSION)
  assert.equal(config.serverName, DEFAULT_SERVER_NAME)
  assert.equal(config.packageSpec, '')
  assert.equal(config.cacheDir, '')
  assert.equal(config.toolCallTimeoutMs, 60_000)
  assert.equal(config.pollIntervalMs, 3_000)
  assert.equal(config.pollMaxMs, 0)
  assert.equal(config.telemetry, true)
  assert.equal(config.cliProbe, true)
  assert.equal(config.usageGuidance, true)
  assert.equal(config.diagnosticTool, false)
  // Off by default: the home directory is not a project unless the deployment says so.
  assert.equal(config.allowHomeProject, false)
  assert.deepEqual(validateConfig(config), { ok: true })
})

test('the settings schema leaves every field undefined when the user set nothing', () => {
  const resolved = new SettingsSchema({})
  assert.deepEqual(resolved, {})
  for (const key of ['enabled', 'version', 'packageSpec', 'cacheDir', 'toolCallTimeoutMs']) {
    assert.equal(resolved[key], undefined)
  }
})

test('only defined settings values override the row configuration', () => {
  const base = new Config({ version: '1.6.0', serverName: 'codegraph', toolCallTimeoutMs: 60_000 })
  const merged = resolveEffective(base, { version: '1.5.0' })
  assert.equal(merged.version, '1.5.0')
  assert.equal(merged.toolCallTimeoutMs, 60_000)
  assert.equal(merged.serverName, 'codegraph')
})

test('clearing packageSpec in settings restores the version-derived default', () => {
  const base = new Config({ version: '1.5.0', packageSpec: 'codegraph@1.4.0' })
  assert.equal(packageSpecFor(base.packageSpec, base.version), 'codegraph@1.4.0')
  const merged = resolveEffective(base, { packageSpec: '' })
  assert.equal(packageSpecFor(merged.packageSpec, merged.version), `${CODEGRAPH_PACKAGE}@1.5.0`)
})

test('a user layer can turn the home-directory refusal off live', () => {
  // The settings-layer equivalent of the CLI's `--force`.
  assert.equal(resolveEffective(new Config({}), { allowHomeProject: true }).allowHomeProject, true)
  assert.equal(resolveEffective(new Config({ allowHomeProject: true }), {}).allowHomeProject, true)
})

test('a user layer can switch the feature off live', () => {
  assert.equal(resolveEffective(new Config({}), { enabled: false }).enabled, false)
})

test('package specs are built from the version unless one is given', () => {
  assert.equal(packageSpecFor('', '1.6.0'), `${CODEGRAPH_PACKAGE}@1.6.0`)
  assert.equal(packageSpecFor('  ', 'next'), `${CODEGRAPH_PACKAGE}@next`)
  assert.equal(packageSpecFor('  @colbymchenry/codegraph@1.5.0 ', '1.6.0'), '@colbymchenry/codegraph@1.5.0')
  assert.equal(packageSpecFor('', ''), `${CODEGRAPH_PACKAGE}@${DEFAULT_VERSION}`)
})

test('invalid server names are refused', () => {
  for (const serverName of ['', 'has space', 'sla/sh', 'x'.repeat(33), 'emoji😀']) {
    const result = validateConfig(new Config({ serverName }))
    assert.equal(result.ok, false, `expected ${JSON.stringify(serverName)} to be refused`)
  }
  assert.equal(validateConfig(new Config({ serverName: 'codegraph-2' })).ok, true)
})

test('a packageSpec that could be read as an npx flag is refused', () => {
  for (const packageSpec of ['--registry=http://evil', '-y', 'pkg name', 'pkg;rm -rf /']) {
    const result = validateConfig(new Config({ packageSpec }))
    assert.equal(result.ok, false, `expected ${JSON.stringify(packageSpec)} to be refused`)
  }
  for (const packageSpec of ['@scope/pkg', 'pkg@1.2.3', '@colbymchenry/codegraph@next', 'file:/tmp/pkg.tgz']) {
    assert.equal(validateConfig(new Config({ packageSpec })).ok, true, `expected ${packageSpec} to be accepted`)
  }
})

test('an invalid version is refused only when no packageSpec overrides it', () => {
  assert.equal(validateConfig(new Config({ version: '@1.6.0' })).ok, false)
  assert.equal(validateConfig(new Config({ version: '1.6.0' })).ok, true)
  assert.equal(validateConfig(new Config({ version: 'next' })).ok, true)
  assert.equal(validateConfig(new Config({ version: '@bad', packageSpec: 'pkg@1.0.0' })).ok, true)
})

test('numeric knobs are range-checked', () => {
  assert.equal(validateConfig(new Config({ toolCallTimeoutMs: 0 })).ok, false)
  assert.equal(validateConfig(new Config({ toolCallTimeoutMs: -1 })).ok, false)
  assert.equal(validateConfig(new Config({ pollIntervalMs: 100 })).ok, false)
  assert.equal(validateConfig(new Config({ pollMaxMs: -1 })).ok, false)
  assert.equal(validateConfig(new Config({ pollMaxMs: 0 })).ok, true)
})

test('every validation problem is reported at once', () => {
  const result = validateConfig(new Config({ serverName: 'bad name', toolCallTimeoutMs: 0 }))
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 2)
})
