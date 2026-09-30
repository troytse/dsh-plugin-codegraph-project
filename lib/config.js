/**
 * Row configuration and the user settings namespace.
 *
 * Two layers, one resolved value:
 *
 * - The **row config** (this plugin's entry in the profile composition, patchable in
 *   `cordis.patch.yml`) is the deployment's installation-level posture. It carries real
 *   defaults, so a plugin row is fully usable with no further setup.
 * - The **settings namespace** `codegraph-project` is the user layer on hosts that still
 *   serve plugin-registered namespaces (DSH before 0.2.0). Every field is deliberately
 *   OPTIONAL WITH NO SCHEMA DEFAULT: the resolved settings value reports `undefined` for
 *   "the user never set this", and a schema default would silently masquerade as a user
 *   override and pin the row config below it. That is why `resolveEffective()` merges only
 *   defined settings values. From DSH 0.2.0 the `settings` service exposes no `register()`
 *   (settings are addressed by Loader entry id), so the row config is the only channel
 *   there and `index.js` says so in the log instead of failing silently.
 *
 * @module dsh-plugin-codegraph-project/config
 */

import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'

/** Settings namespace owned by this plugin (also the settings card key). */
export const SETTINGS_NAMESPACE = 'codegraph-project'

/** CodeGraph's npm package, used to build the `npx` package spec. */
export const CODEGRAPH_PACKAGE = '@colbymchenry/codegraph'

/** Pinned default version: the release this plugin was verified against. */
export const DEFAULT_VERSION = '1.6.0'

/** MCP `serverName`, which fixes the public tool namespace `mcp__<serverName>__<tool>`. */
export const DEFAULT_SERVER_NAME = 'codegraph'

/** Legal `serverName`, matching dsh-mcp-client's own namespace budget. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** A version or dist-tag is restricted to npm's own version grammar. */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

/**
 * A full package spec is passed as ONE `npx` argument and never through a shell, but a
 * whitelist still keeps a configuration typo from becoming an argument-injection bug: the
 * first character cannot be `-` (that would be read as an npx flag), and `@`, `:`, and `+`
 * are admitted only inside the string, for `scope@version`, `dist-tag`, `file:` and local
 * paths.
 *
 * `packageSpec` makes npx load and execute code from wherever it points, so a local
 * (`file:` / `git+file:`) spec is further restricted to an ABSOLUTE path: a relative one
 * (`file:../../somewhere/pkg`) would let the row reach out of its own tree, and the operator
 * reading the config could not tell which local package actually ran. Prefixes are matched
 * case-insensitively, because npm's own `npa` lower-cases the spec before deciding it is local.
 */
const PACKAGE_SPEC_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._~/:@+-]*$/

/** Local-code spec prefixes (`git+file:` clones a local repository instead of fetching one). */
const FILE_SPEC_PREFIXES = Object.freeze(['file:', 'git+file:'])

/**
 * The error for a local (`file:` / `git+file:`) package spec that is not an absolute path, or
 * `undefined` when the spec is not a local spec at all.
 *
 * @param {string} spec
 * @returns {string | undefined}
 */
function fileSpecError(spec) {
  const lower = spec.toLowerCase()
  const prefix = FILE_SPEC_PREFIXES.find((candidate) => lower.startsWith(candidate))
  if (prefix === undefined) return undefined
  // Quote the operator's own spelling (`FILE:`, `GIT+FILE:`) in the message, not the
  // normalized prefix the lookup happens to use.
  const written = spec.slice(0, prefix.length)
  const target = spec.slice(prefix.length)
  if (!isAbsolute(target)) {
    return `packageSpec ${JSON.stringify(spec)} uses a relative ${written} path; ${written} specs must be absolute so the loaded code is explicit`
  }
  return undefined
}

/** Row configuration schema and defaults. */
export const Config = z.object({
  /** Master switch. When false nothing is spawned and no tool is registered. */
  enabled: z.boolean().default(true),
  /** Global CodeGraph version launched through npx. */
  version: z.string().default(DEFAULT_VERSION),
  /** Full package spec override (mirror, private registry, local tarball). Wins over `version`. */
  packageSpec: z.string().default(''),
  /** npm cache directory for the npx install. Empty means `~/.dsh/codegraph/npm-cache`. */
  cacheDir: z.string().default(''),
  /** MCP tool namespace; the model-facing name becomes `mcp__<serverName>__codegraph_explore`. */
  serverName: z.string().default(DEFAULT_SERVER_NAME),
  /** Per-call timeout for one MCP tool invocation. */
  toolCallTimeoutMs: z.number().default(60_000),
  /** How often a workspace with no index is re-checked for a newly created one. */
  pollIntervalMs: z.number().default(3_000),
  /** Give up watching an unindexed workspace after this long. 0 means watch for the session's life. */
  pollMaxMs: z.number().default(0),
  /**
   * Explicit CodeGraph anonymous-telemetry preference to forward as `CODEGRAPH_TELEMETRY`.
   *
   * Deliberately has NO default: `undefined` means "the operator did not set it", and the
   * plugin then injects nothing so CodeGraph decides from the user's own environment. A
   * default of `true` would be the plugin switching telemetry ON, which the documentation
   * promised it never does.
   */
  telemetry: z.boolean(),
  /**
   * Probe `npx ... version` once at activation and log the outcome.
   *
   * Off by default: the probe runs on EVERY app start regardless of whether anyone uses
   * CodeGraph, and a cold npm cache makes it download the platform bundle (tens of MB) while
   * the first session's own `npx` launch is racing for the same cache. Opt in when the
   * cache-warming diagnostics are worth that startup cost.
   */
  cliProbe: z.boolean().default(false),
  /** Inject a short CodeGraph usage section into the prompt of mounted sessions only. */
  usageGuidance: z.boolean().default(true),
  /** Register one extra diagnostic tool describing this workspace's state. Off by default. */
  diagnosticTool: z.boolean().default(false),
  /**
   * Treat the home directory (and the filesystem root) as a project when they contain an index.
   * Off by default, mirroring the CLI's refusal to initialize them without `--force`.
   */
  allowHomeProject: z.boolean().default(false),
})

/** Keys the row schema actually declares. */
const ROW_CONFIG_KEYS = Object.freeze(Object.keys(Config.dict ?? {}))

/**
 * Keys a row config may legally carry: the schema's own, plus `argvBuilder`, which is a test
 * seam rather than a knob (`index.js` reads it directly) and therefore cannot live in the
 * JSON-schema-shaped row config.
 */
const ACCEPTED_CONFIG_KEYS = new Set([...ROW_CONFIG_KEYS, 'argvBuilder'])

/**
 * User-settings schema. All fields optional and default-free, for the reason in the
 * module header: `undefined` is the only honest encoding of "the user did not set it".
 *
 * `enabled` is deliberately NOT part of this layer. The row config's `enabled` is honored
 * by the loader before `apply()` runs (a disabled row never activates), while a user-layer
 * `enabled` was only ever read once at activation, so it could not switch a running plugin
 * off — offering it here promised a live switch that did not exist.
 */
export const SettingsSchema = z.object({
  version: z.string(),
  packageSpec: z.string(),
  cacheDir: z.string(),
  toolCallTimeoutMs: z.number(),
  allowHomeProject: z.boolean(),
})

/**
 * Build the npx package spec for a resolved version.
 *
 * @param {string} packageSpec - Explicit spec override; when non-empty it wins verbatim.
 * @param {string} version - Version or dist-tag.
 * @returns {string} The spec passed to npx.
 */
export function packageSpecFor(packageSpec, version) {
  if (typeof packageSpec === 'string' && packageSpec.trim() !== '') return packageSpec.trim()
  const tag = typeof version === 'string' && version.trim() !== '' ? version.trim() : DEFAULT_VERSION
  return `${CODEGRAPH_PACKAGE}@${tag}`
}

/**
 * Validate the knobs whose failure mode is a confusing runtime error rather than a
 * startup rejection, so a bad value is refused where a human can still see it.
 *
 * @param {object} config - Resolved settings-merged configuration.
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateConfig(config) {
  const errors = []
  // The row schema tolerates unknown keys (schemastery keeps them verbatim), so a typo such as
  // `toolCallTimeoutsMs` would otherwise be accepted and silently do nothing.
  for (const key of Object.keys(config ?? {})) {
    if (!ACCEPTED_CONFIG_KEYS.has(key)) {
      errors.push(`unknown configuration key ${JSON.stringify(key)}; accepted keys are ${ROW_CONFIG_KEYS.join(', ')}`)
    }
  }
  if (!SERVER_NAME_PATTERN.test(config.serverName ?? '')) {
    errors.push(`serverName ${JSON.stringify(config.serverName)} must match ${SERVER_NAME_PATTERN}`)
  }
  const spec = typeof config.packageSpec === 'string' ? config.packageSpec.trim() : ''
  if (spec !== '' && !PACKAGE_SPEC_PATTERN.test(spec)) {
    errors.push(`packageSpec ${JSON.stringify(config.packageSpec)} contains characters npm package specs cannot use`)
  }
  if (spec !== '') {
    const fileError = fileSpecError(spec)
    if (fileError !== undefined) errors.push(fileError)
  }
  if (spec === '' && !VERSION_PATTERN.test(String(config.version ?? ''))) {
    errors.push(`version ${JSON.stringify(config.version)} is not a valid npm version or dist-tag`)
  }
  if (!Number.isFinite(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0) {
    errors.push(`toolCallTimeoutMs must be a positive number, got ${JSON.stringify(config.toolCallTimeoutMs)}`)
  }
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 250) {
    errors.push(`pollIntervalMs must be at least 250ms, got ${JSON.stringify(config.pollIntervalMs)}`)
  }
  if (!Number.isFinite(config.pollMaxMs) || config.pollMaxMs < 0) {
    errors.push(`pollMaxMs must be zero (unlimited) or a positive number, got ${JSON.stringify(config.pollMaxMs)}`)
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/**
 * Merge the user settings layer over the composition layer.
 *
 * Only DEFINED values override. An empty string is a real value for `packageSpec` and
 * `cacheDir` (both mean "not set, use the default"), so a user clearing one of those
 * fields restores the default instead of being ignored.
 *
 * @param {object} base - Row config, already schema-resolved.
 * @param {object | undefined} user - Resolved settings section, possibly undefined.
 * @returns {object} Effective configuration.
 */
export function resolveEffective(base, user) {
  const effective = { ...base }
  if (user === undefined || user === null) return effective
  for (const key of ['version', 'packageSpec', 'cacheDir', 'toolCallTimeoutMs', 'allowHomeProject']) {
    const value = user[key]
    if (value !== undefined) effective[key] = value
  }
  return effective
}
