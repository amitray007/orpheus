import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import {
  ControlBridgeError,
  getCatalog,
  invokeCapability,
  waitForCatalogChange
} from './controlClient.js'
import type { ControlCapability, ControlCatalog, JsonSchema } from './protocol.js'

function inputSchema(schema: JsonSchema): Tool['inputSchema'] {
  return schema as Tool['inputSchema']
}

function outputSchema(schema: JsonSchema): NonNullable<Tool['outputSchema']> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: schema }
  }
}

function toTool(capability: ControlCapability): Tool {
  return {
    name: capability.id,
    description: capability.description,
    inputSchema: inputSchema(capability.inputSchema),
    outputSchema: outputSchema(capability.outputSchema),
    annotations: {
      readOnlyHint: capability.kind === 'query',
      destructiveHint: capability.kind === 'mutation',
      idempotentHint: capability.kind === 'query',
      openWorldHint: false
    }
  }
}

function resultText(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 'null' : serialized
}

function errorText(error: unknown): string {
  if (error instanceof ControlBridgeError) {
    return JSON.stringify({ code: error.code, message: error.message })
  }
  return JSON.stringify({
    code: 'bridge_failed',
    message: error instanceof Error ? error.message : String(error)
  })
}

const server = new Server(
  { name: 'orpheus-control', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } }
)

let currentCatalog: ControlCatalog | null = null
let monitorController: AbortController | null = null
let monitorPromise: Promise<void> | null = null

async function refreshCatalog(): Promise<ControlCatalog> {
  const catalog = await getCatalog()
  if (currentCatalog != null && catalog.revision < currentCatalog.revision) {
    throw new ControlBridgeError('protocol', 'control catalog revision regressed')
  }
  currentCatalog = catalog
  return catalog
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const catalog = await refreshCatalog()
  return { tools: catalog.capabilities.map(toTool) }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const value = await invokeCapability(request.params.name, request.params.arguments ?? {})
    return {
      content: [{ type: 'text', text: resultText(value) }],
      structuredContent: { value }
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: errorText(error) }]
    }
  }
})

const transport = new StdioServerTransport()

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs)
    timer.unref?.()
    function done(): void {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function monitorCatalog(signal: AbortSignal): Promise<void> {
  let failures = 0
  while (!signal.aborted) {
    try {
      const catalog = currentCatalog ?? (await refreshCatalog())
      const wait = await waitForCatalogChange(catalog.revision, signal)
      if (signal.aborted) return
      if (wait.revision < catalog.revision) {
        throw new ControlBridgeError('protocol', 'control catalog wait revision regressed')
      }
      if (wait.changed) {
        const beforeRevision = currentCatalog?.revision ?? catalog.revision
        const refreshed = await refreshCatalog()
        if (refreshed.revision > beforeRevision) await server.sendToolListChanged()
      }
      failures = 0
    } catch (error) {
      if (signal.aborted) return
      if (
        error instanceof ControlBridgeError &&
        (error.code === 'unauthorized' || error.code === 'aborted')
      ) {
        return
      }
      failures++
      await abortableDelay(Math.min(5_000, 250 * 2 ** Math.min(failures - 1, 5)), signal)
    }
  }
}

function startCatalogMonitor(): void {
  if (monitorPromise != null) return
  const controller = new AbortController()
  monitorController = controller
  monitorPromise = monitorCatalog(controller.signal).finally(() => {
    if (monitorController === controller) monitorController = null
    monitorPromise = null
  })
}

function stopCatalogMonitor(): void {
  monitorController?.abort()
}

async function main(): Promise<void> {
  let shuttingDown = false

  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    stopCatalogMonitor()
    void server.close().catch(() => {})
  }

  try {
    server.oninitialized = startCatalogMonitor
    server.onclose = stopCatalogMonitor
    process.stdin.once('end', shutdown)
    process.stdin.once('close', shutdown)
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    await server.connect(transport)
  } catch (error) {
    console.error('[orpheus-mcp] fatal:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

void main()
