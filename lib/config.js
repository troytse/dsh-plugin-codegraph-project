/**
 * Row configuration and the user settings namespace.
 *
 * Two layers, one resolved value:
 *
 * - The **row config** (this plugin's entry in the profile composition, patchable in
 *   `cordis.patch.yml`) is the deployment's installation-level posture. It carries real
 *   defaults, so a plugin row is fully usable with no further setup.
 * - The **settings namespace** `codegraph-project` is the user layer, edited through
 *   DSH's settings document. Every field is deliberately OPTIONAL WITH NO SCHEMA DEFAULT:
 *   the resolved settings value reports `undefined` for "the user never set this", and a
 *   schema default would silently masquerade as a user override and pin the row config
 *   below it. That is why `resolveEffective()` merges only defined settings values.
 *
 * @module dsh-plugin-codegraph-project/config
 */

import z from '@deepseek-ai/schemastery'

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
 */
const PACKAGE_SPEC_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._~/:@+-]*$/

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
  /** Forward CodeGraph's own anonymous telemetry preference (CODEGRAPH_TELEMETRY). */
  telemetry: z.boolean().default(true),
  /** Probe `npx ... version` once at activation and log the outcome. */
  cliProbe: z.boolean().default(true),
  /** Inject a short CodeGraph usage section into the prompt of mounted sessions only. */
  usageGuidance: z.boolean().default(true),
  /** Register one extra diagnostic tool describing this workspace's state. Off by default. */
  diagnosticTool: z.boolean().default(false),
})

/**
 * User-settings schema. All fields optional and default-free, for the reason in the
 * module header: `undefined` is the only honest encoding of "the user did not set it".
 */
export const SettingsSchema = z.object({
  enabled: z.boolean(),
  version: z.string(),
  packageSpec: z.string(),
  cacheDir: z.string(),
  toolCallTimeoutMs: z.number(),
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
  if (!SERVER_NAME_PATTERN.test(config.serverName ?? '')) {
    errors.push(`serverName ${JSON.stringify(config.serverName)} must match ${SERVER_NAME_PATTERN}`)
  }
  const spec = typeof config.packageSpec === 'string' ? config.packageSpec.trim() : ''
  if (spec !== '' && !PACKAGE_SPEC_PATTERN.test(spec)) {
    errors.push(`packageSpec ${JSON.stringify(config.packageSpec)} contains characters npm package specs cannot use`)
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
  for (const key of ['enabled', 'version', 'packageSpec', 'cacheDir', 'toolCallTimeoutMs']) {
    const value = user[key]
    if (value !== undefined) effective[key] = value
  }
  return effective
}
