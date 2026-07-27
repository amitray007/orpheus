import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { ControlBridgeError, invokeCapability, listCapabilities } from './controlClient.js'
import type { ControlCapability, JsonSchema } from './protocol.js'

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
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const capabilities = await listCapabilities()
  return { tools: capabilities.map(toTool) }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const capabilities = await listCapabilities()
    if (!capabilities.some((capability) => capability.id === request.params.name)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: 'not_found',
              message: `Control capability is not published: ${request.params.name}`
            })
          }
        ]
      }
    }

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

async function main(): Promise<void> {
  try {
    await server.connect(transport)
  } catch (error) {
    console.error('[orpheus-mcp] fatal:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

void main()
