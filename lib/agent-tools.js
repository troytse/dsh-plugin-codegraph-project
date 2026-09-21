/**
 * Tool installation and per-session gating.
 *
 * **Why registration is global and the gate is per session.** DSH's tool registry accepts
 * agent-scoped registration (`ctx.tools.register()` through `agent.ctx`), but the model's tool
 * list is assembled with `scope: agent` — the *Agent object*, not the scope key the registry
 * keys its layers by — so an agent-scoped definition never reaches the model. That was
 * measured, not assumed: with a tool registered through an agent's context, the session's own
 * `schemas(scopeKey)` view contains it while `systemPrompt.assemble({ agent, scope: agent })`
 * — the exact call the agent loop makes — returns an empty list. The same measurement shows
 * `restrict()` is evaluated against the scope key too, so it cannot hide a tool from the
 * model's list either.
 *
 * The mechanisms that DO work per session are `ctx.tools.guard()` (proven: a guard registered
 * through one agent's context denies that agent's call and leaves another agent's call alone)
 * and the per-session prompt section. This module therefore pairs one reference-counted global
 * registration per tool name with a per-session guard that refuses calls from sessions whose
 * project has no index, carrying a reason that tells the model what to do instead.
 *
 * @module dsh-plugin-codegraph-project/agent-tools
 */

import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** DeepSeek function-name budget for one model-facing tool name. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** Characters the function-name contract forbids. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex characters of the identity hash appended when normalization changes a name. */
const HASH_LENGTH = 12

/** Value-schema types the registry's DSL accepts directly. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'json'])
/** Annotation keywords the DSL understands. */
const ANNOTATIONS = ['description', 'title', 'default', 'examples']
/** Structural keys a branch consumes rather than passes through. */
const CONSUMED_KEYS = ['type', 'properties', 'items', 'required', 'additionalProperties', 'oneOf']

/**
 * The model-facing name for one MCP tool, identical to the MCP client bridge's algorithm so
 * that moving between the two bridges never renames a tool the model has already seen.
 *
 * @param {string} serverName
 * @param {string} rawName
 * @returns {string}
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Project MCP content blocks into the harness's core content vocabulary.
 *
 * Only text is carried through; any other block becomes an explicit diagnostic rather than
 * silence, so the model never loses the fact that something came back.
 *
 * @param {unknown} content
 * @param {string} toolName
 * @returns {Array<{ type: 'text', text: string }>}
 */
export function projectContent(content, toolName) {
  if (!Array.isArray(content)) return []
  const projected = []
  const text = []
  const flush = () => {
    if (text.length === 0) return
    projected.push({ type: 'text', text: text.splice(0).join('\n') })
  }
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text)
      continue
    }
    flush()
    const kind = block !== null && typeof block === 'object' && typeof block.type === 'string' ? block.type : 'unknown'
    projected.push({ type: 'text', text: `[${toolName}] dropped a "${kind}" result block: this bridge carries text results only` })
  }
  flush()
  return projected
}

/**
 * Convert an MCP tool's JSON Schema into the schema DSL `defineTool` compiles.
 *
 * The two vocabularies overlap but are not the same: the DSL is a property map whose object
 * nodes must state `additionalProperties` explicitly, and it rejects keywords such as
 * `minLength`, `format`, or `$comment`. This normalization keeps the structure the model
 * needs — names, types, annotations, enums, requiredness — and reports what it dropped.
 *
 * @param {unknown} schema - The server's `inputSchema`.
 * @param {(message: string) => void} [onDropped] - Diagnostic sink for dropped keywords.
 * @returns {{ parameters: object, dropped: string[] }}
 */
export function toToolParameters(schema, onDropped) {
  const dropped = []
  const root = isRecord(schema) ? schema : { type: 'object', properties: {} }
  const source = isRecord(root.properties) ? root.properties : {}
  const required = new Set(Array.isArray(root.required) ? root.required.filter((name) => typeof name === 'string') : [])
  const parameters = {}
  for (const [propertyName, propertySchema] of Object.entries(source)) {
    parameters[propertyName] = toValueSchema(propertySchema, `parameters.${propertyName}`, dropped)
    if (required.has(propertyName) || propertySchema?.required === true) parameters[propertyName].required = true
  }
  for (const name of dropped) onDropped?.(name)
  return { parameters, dropped }
}

/**
 * Normalize one value schema node.
 *
 * @param {unknown} node
 * @param {string} path
 * @param {string[]} dropped
 * @returns {object}
 */
function toValueSchema(node, path, dropped) {
  if (!isRecord(node)) return { type: 'json' }
  if (Array.isArray(node.oneOf)) {
    const branches = node.oneOf.map((branch, index) => toValueSchema(branch, `${path}.oneOf[${index}]`, dropped))
    return { oneOf: branches.length >= 2 ? branches : [branches[0] ?? { type: 'json' }], ...annotationsOf(node) }
  }
  const type = typeof node.type === 'string' ? node.type : undefined
  if (type === 'object' || (type === undefined && isRecord(node.properties))) {
    const properties = {}
    const required = new Set(Array.isArray(node.required) ? node.required.filter((name) => typeof name === 'string') : [])
    for (const [name, child] of Object.entries(isRecord(node.properties) ? node.properties : {})) {
      properties[name] = toValueSchema(child, `${path}.properties.${name}`, dropped)
      if (required.has(name) || child?.required === true) properties[name].required = true
    }
    // The DSL requires object nodes to state openness explicitly.
    return { type: 'object', properties, additionalProperties: node.additionalProperties === false ? false : true, ...annotationsOf(node) }
  }
  if (type === 'array') {
    return { type: 'array', items: node.items === undefined ? { type: 'json' } : toValueSchema(node.items, `${path}.items`, dropped), ...annotationsOf(node) }
  }
  if (type !== undefined && SCALAR_TYPES.has(type)) {
    const value = { type, ...annotationsOf(node) }
    if (Array.isArray(node.enum) && node.enum.length > 0) value.enum = [...node.enum]
    if (node.const !== undefined) value.const = node.const
    // The DSL spells requiredness per property; MCP servers spell it with a root `required`
    // array. Honor either spelling so a mixed schema still compiles.
    if (node.required === true) value.required = true
    collectUnsupported(node, ['type', 'enum', 'const', 'required', ...ANNOTATIONS], path, dropped)
    return value
  }
  dropped.push(`${path}.type=${String(type)} (unsupported; treated as json)`)
  return { type: 'json', ...annotationsOf(node) }
}

/** Copy the annotation keywords the DSL understands. */
function annotationsOf(node) {
  const value = {}
  for (const key of ANNOTATIONS) if (Object.hasOwn(node, key)) value[key] = node[key]
  return value
}

/** Record keywords the DSL does not accept, so a shrinking schema is visible in the logs. */
function collectUnsupported(node, consumed, path, dropped) {
  for (const key of Object.keys(node)) {
    if (consumed.includes(key) || CONSUMED_KEYS.includes(key) || ANNOTATIONS.includes(key)) continue
    dropped.push(`${path}.${key}`)
  }
}

/** Whether a value is a plain record. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build one bridged tool definition for a hub tool.
 *
 * @param {object} options
 * @param {string} options.publicName - Model-facing name.
 * @param {string} options.rawName - Name used on the MCP wire.
 * @param {string} options.description - Description reported by the server.
 * @param {object} options.parameters - JSON Schema reported by the server.
 * @param {(rawName: string, args: object, exec: object) => Promise<object>} options.call
 * @param {number} options.timeoutMs
 * @returns {object} A registry-ready tool definition.
 */
export function createBridgedTool(options) {
  const { publicName, rawName, description, parameters, call, timeoutMs } = options
  const { parameters: normalized } = toToolParameters(parameters)
  return defineTool({
    name: publicName,
    description: description === '' ? `CodeGraph tool "${rawName}"` : description,
    parameters: normalized,
    timeoutMs,
    output: {
      // The canonical value mirrors the MCP client bridge. `required` is deliberately absent:
      // the registry's value-schema DSL does not accept it on the output root, and `render`
      // already treats a missing `content` as empty.
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: { type: 'json' } },
          structuredContent: { type: 'json' },
        },
        additionalProperties: false,
      },
      render(_args, value) {
        const blocks = Array.isArray(value?.content) ? value.content : []
        const text = blocks
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
        return [{ type: 'text', text: text === '' ? `[${rawName}] (no output)` : text }]
      },
    },
    async execute(args, exec) {
      const result = await call(rawName, args ?? {}, exec)
      return {
        content: projectContent(result?.content, rawName),
        ...(result?.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      }
    },
  })
}

/**
 * Reference-counted registry of model-facing tool definitions plus the per-session routing the
 * executors consult.
 *
 * One definition exists per tool NAME while at least one project connection advertises it, so
 * two projects whose servers expose the same tool name share a single registration; the
 * executor routes each call to the calling session's own project.
 */
export class ToolAggregate {
  /**
   * @param {object} options
   * @param {object} options.tools - The root `ctx.tools` service.
   * @param {object} options.logger
   */
  constructor(options) {
    this.tools = options.tools
    this.logger = options.logger
    /** @type {Map<string, { refs: number, dispose: () => void, roots: Set<string> }>} */
    this.entries = new Map()
    /** agent id -> project root, maintained as sessions mount and unmount. */
    this.routing = new Map()
    /** project root -> hub, so an executor can find the live connection for its project. */
    this.hubsByRoot = new Map()
  }

  /** Replace the project-connection table the executors read. */
  setHubs(hubsByRoot) {
    this.hubsByRoot = hubsByRoot
  }

  /** Record which project a session is mounted on. */
  route(agentId, projectRoot) {
    this.routing.set(String(agentId), projectRoot)
  }

  /** Forget a session's route. */
  unroute(agentId) {
    this.routing.delete(String(agentId))
  }

  /** The project root a session is mounted on, if any. */
  routeOf(agentId) {
    return this.routing.get(String(agentId))
  }

  /**
   * Register every tool a hub advertises (once per name) and return a disposer that releases
   * this hub's reference.
   *
   * @param {object} hub
   * @returns {() => void} Idempotent release for this hub's reference.
   */
  retain(hub) {
    const names = []
    for (const tool of hub.tools()) {
      const publicName = publicToolName(hub.serverName, tool.name)
      const existing = this.entries.get(publicName)
      if (existing !== undefined) {
        existing.refs += 1
        existing.roots.add(hub.projectRoot)
        names.push(publicName)
        continue
      }
      const definition = createBridgedTool({
        publicName,
        rawName: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        call: (rawName, args, exec) => this.#callFor(exec, hub, rawName, args),
        timeoutMs: hub.toolCallTimeoutMs,
      })
      let dispose
      try {
        dispose = this.tools.register(definition)
      } catch (error) {
        this.logger.error(`could not register ${publicName}: ${String(error?.message ?? error)}`)
        continue
      }
      this.entries.set(publicName, { refs: 1, dispose, roots: new Set([hub.projectRoot]) })
      names.push(publicName)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const name of names) {
        const entry = this.entries.get(name)
        if (entry === undefined) continue
        entry.refs -= 1
        entry.roots.delete(hub.projectRoot)
        if (entry.refs > 0) continue
        this.entries.delete(name)
        try { entry.dispose() } catch { /* already unwound with the fiber */ }
      }
    }
  }

  /** Tool names currently registered. */
  names() {
    return [...this.entries.keys()]
  }

  /** Project roots a given tool name currently serves. */
  rootsOf(name) {
    return [...(this.entries.get(name)?.roots ?? [])]
  }

  /**
   * Route one tool call to the calling session's project connection.
   *
   * The session guard has already established that this agent is mounted, so the routing entry
   * is authoritative; the fallback keeps a call from failing when routing and the call race.
   *
   * @param {{ agent?: { id?: string } } | undefined} exec
   * @param {object} fallbackHub
   * @param {string} rawName
   * @param {object} args
   * @returns {Promise<object>}
   */
  async #callFor(exec, fallbackHub, rawName, args) {
    const agentId = exec?.agent?.id
    const root = agentId === undefined ? undefined : this.routing.get(String(agentId))
    const hub = (root === undefined ? undefined : this.hubsByRoot.get(root)) ?? fallbackHub
    return hub.call(rawName, args, exec)
  }
}

/**
 * Register the ONE guard that enforces per-session CodeGraph access.
 *
 * A guard registered on an agent's scope would be ideal, but DSH makes that unreachable from a
 * plugin: `agent.ctx` does not carry `tools` as a readable dependency (`ctx.tools` throws
 * "cannot get property ... without inject"), and the context handed to an `inject` callback is a
 * DIFFERENT context whose guard registration is not consulted for the agent's calls. What does
 * work is a plain-context guard, which sees every call and receives the calling agent on the
 * execution — so this registers exactly one root guard and decides per call.
 *
 * @param {object} options
 * @param {object} options.tools - The root `ctx.tools` service.
 * @param {(agentId: string | undefined) => boolean} options.mayCall - Whether that session may
 *   call CodeGraph right now.
 * @param {(agentId: string | undefined) => string} options.reason - The refusal text.
 * @param {() => ReadonlySet<string> | readonly string[]} options.gatedNames - Reads the tool
 *   names this guard owns. A reader rather than a snapshot: sessions are often gated before any
 *   project connection exists, so the set to refuse is only known later.
 * @returns {() => void} Remover.
 */
export function registerSessionGuard(options) {
  const { tools, mayCall, reason, gatedNames } = options
  return tools.guard((exec) => {
    const name = String(exec?.name ?? '')
    const owned = typeof gatedNames === 'function' ? gatedNames() : gatedNames
    const isOwned = typeof owned?.has === 'function' ? owned.has(name) : Array.isArray(owned) && owned.includes(name)
    if (!isOwned) return undefined
    const agentId = exec?.agent?.id === undefined ? undefined : String(exec.agent.id)
    try {
      return mayCall(agentId) ? undefined : reason(agentId)
    } catch {
      return reason(agentId)
    }
  })
}
