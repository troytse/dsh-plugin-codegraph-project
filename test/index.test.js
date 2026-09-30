/**
 * Plugin-level units that are not covered elsewhere: the child environment the plugin hands to
 * the managed subprocess service, and the activation-time CLI probe's deadline handling.
 *
 * These live in `lib/index.js` rather than in a helper module, so they are exercised directly here
 * instead of through a full Cordis assembly (which `integration.test.js` covers).
 */

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { buildChildEnv, runCliProbe } from '../lib/index.js'

const CACHE = '/tmp/cg-index-test-cache'

test('telemetry is forwarded only when the operator set it explicitly', () => {
  // Unset: leave CODEGRAPH_TELEMETRY out entirely, so CodeGraph applies the user's own
  // environment instead of the plugin switching telemetry on (or off) for them.
  assert.equal('CODEGRAPH_TELEMETRY' in buildChildEnv({}, CACHE), false)
  assert.equal('CODEGRAPH_TELEMETRY' in buildChildEnv({ telemetry: undefined }, CACHE), false)
  // An explicit preference is forwarded both ways.
  assert.equal(buildChildEnv({ telemetry: true }, CACHE).CODEGRAPH_TELEMETRY, '1')
  assert.equal(buildChildEnv({ telemetry: false }, CACHE).CODEGRAPH_TELEMETRY, '0')
  // The npm cache is always set, with both spellings.
  assert.equal(buildChildEnv({}, CACHE).NPM_CONFIG_CACHE, CACHE)
  assert.equal(buildChildEnv({}, CACHE).npm_config_cache, CACHE)
})

test('the activation-time CLI probe clears its deadline timer once the probe answers', async () => {
  // Assert on the SPECIFIC timer the probe armed, not on a global call count: the latter couples
  // the test to internals and to unrelated `clearTimeout` calls across Node versions.
  const setTimer = mock.method(globalThis, 'setTimeout')
  const clearTimer = mock.method(globalThis, 'clearTimeout')
  const messages = []
  const logger = { info: (message) => messages.push(message), warn: (message) => messages.push(message) }
  const subprocess = {
    async resolveExecutable() { return '/fake/npx' },
    spawn() { return { done: Promise.resolve({ exitCode: 0 }), terminate() {} } },
  }
  try {
    await runCliProbe({ deps: { subprocess, env: {}, packageSpec: 'codegraph@1.0.0' }, logger })
    const deadlineCall = setTimer.mock.calls.find((call) => call.arguments[1] === 300_000)
    assert.ok(deadlineCall !== undefined, 'the probe must arm its 300s deadline')
    assert.ok(
      clearTimer.mock.calls.some((call) => call.arguments[0] === deadlineCall.result),
      'the deadline timer must be cleared when the probe answers first',
    )
    assert.match(messages.join('\n'), /runnable through npx/)
  } finally {
    clearTimer.mock.restore()
    setTimer.mock.restore()
  }
})

test('a CLI probe that outlives its deadline is terminated and reported', async () => {
  let terminated = false
  const messages = []
  const logger = { info: (message) => messages.push(message), warn: (message) => messages.push(message) }
  const subprocess = {
    async resolveExecutable() { return '/fake/npx' },
    spawn() { return { done: new Promise(() => {}), terminate() { terminated = true } } },
  }
  // `timeoutMs` is the seam that makes the 300s path testable without waiting 5 minutes.
  await runCliProbe({ deps: { subprocess, env: {}, packageSpec: 'codegraph@1.0.0' }, logger, timeoutMs: 10 })
  assert.equal(terminated, true, 'a probe past its deadline must be terminated')
  assert.match(messages.join('\n'), /timed out after 10ms/)
})
