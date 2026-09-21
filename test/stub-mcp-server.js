/**
 * A stub MCP stdio server used by the pool tests.
 *
 * It speaks just enough of the protocol to exercise the real client path — initialize,
 * tools/list, tools/call, and a manual `notifications/tools/list_changed` trigger — without
 * requiring a CodeGraph install. Behaviour knobs come from the environment so one file
 * covers the success, error, empty-result, and late-tool-set cases:
 *
 *   STUB_TOOLS       comma-separated tool names (default `codegraph_explore`)
 *   STUB_CALL_MODE   `text` (default) | `error` | `empty` | `structured`
 *   STUB_CALL_DELAY  milliseconds to wait before answering a call (for cancellation tests)
 *   STUB_LIST_EXTRA  when set to `1`, the first tools/list hides `codegraph_node` and a
 *                    list_changed notification adds it
 *   STUB_EXIT_AFTER_INIT  `1` exits right after initialize (crash-path tests)
 */

let toolNames = (process.env.STUB_TOOLS ?? 'codegraph_explore').split(',').filter((name) => name !== '')
const callMode = process.env.STUB_CALL_MODE ?? 'text'
const callDelayMs = Number(process.env.STUB_CALL_DELAY ?? '0')
const listExtra = process.env.STUB_LIST_EXTRA === '1'
let extraPublished = false

const buffer = { value: '' }

/** Write one JSON-RPC frame. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Render a tool result body for the configured mode. */
function toolResult(toolName, args) {
  switch (callMode) {
    case 'error':
      return { content: [{ type: 'text', text: `stub error from ${toolName}` }], isError: true }
    case 'empty':
      return { content: [] }
    case 'structured':
      return {
        content: [{ type: 'text', text: `stub structured ${toolName}` }],
        structuredContent: { tool: toolName, query: args?.query ?? null },
      }
    default:
      return { content: [{ type: 'text', text: `stub result for ${String(args?.query ?? '')} from ${toolName}` }] }
  }
}

/** The tool set currently advertised. */
function advertisedTools() {
  const names = [...toolNames]
  if (listExtra && extraPublished) return [...names, 'codegraph_node']
  return names
}

/** Handle one parsed frame. */
async function handle(message) {
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      if (process.env.STUB_EXIT_BEFORE_INIT === '1') {
        // Die without answering: the client's handshake must fail fast on process death
        // rather than sit until its own timeout.
        process.exit(3)
      }
      if (process.env.STUB_EXIT_AFTER_INIT === '1') {
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codegraph-stub', version: '0.0.0' } } })
        // Give the response time to flush before the process disappears.
        setTimeout(() => process.exit(3), 150)
        return
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: listExtra } },
          serverInfo: { name: 'codegraph-stub', version: '0.0.0' },
          instructions: 'stub instructions',
        },
      })
      return
    case 'tools/list': {
      if (listExtra && !extraPublished) {
        // First listing hides the extra tool; a list_changed notification then announces
        // it, so the client's re-sync path is exercised.
        extraPublished = true
        send({ jsonrpc: '2.0', id: message.id, result: { tools: advertisedTools().map(toolDescriptor) } })
        setTimeout(() => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), 50)
        return
      }
      send({ jsonrpc: '2.0', id: message.id, result: { tools: advertisedTools().map(toolDescriptor) } })
      return
    }    case 'tools/call': {
      if (callDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, callDelayMs))
      send({ jsonrpc: '2.0', id: message.id, result: toolResult(message.params?.name, message.params?.arguments) })
      return
    }
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `stub does not implement ${String(message.method)}` } })
  }
}

/** Describe one stub tool. */
function toolDescriptor(name) {
  return {
    name,
    description: `Stub tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Query text' },
        maxFiles: { type: 'number', description: 'Max files' },
        projectPath: { type: 'string', description: 'Project path' },
      },
      required: ['query'],
    },
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer.value += chunk
  let index
  while ((index = buffer.value.indexOf('\n')) !== -1) {
    const line = buffer.value.slice(0, index).trim()
    buffer.value = buffer.value.slice(index + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    void handle(message)
  }
})
process.stdin.on('end', () => process.exit(0))
