import * as http from 'node:http'
import * as path from 'node:path'
import {
  CONTROL_PROTOCOL_VERSION,
  parseCatalog,
  parseCatalogWait,
  parseControlEnvelope,
  type ControlCatalog,
  type ControlCatalogWait,
  type ControlCapability,
  type ControlEnvelope,
  type ControlRequest
} from './protocol.js'

const RESPONSE_SIZE_LIMIT = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 35_000

export class ControlBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ControlBridgeError'
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ControlBridgeError('unavailable', `${name} is not set`)
  }
  return value
}

function resolveSocketPath(): string {
  const socketPath = requiredEnv('ORPHEUS_CMD_SOCK')
  if (!path.isAbsolute(socketPath)) {
    throw new ControlBridgeError('invalid', 'ORPHEUS_CMD_SOCK must be an absolute path')
  }
  return socketPath
}

async function postControl(
  request: ControlRequest,
  signal?: AbortSignal
): Promise<ControlEnvelope> {
  if (signal?.aborted === true) {
    throw new ControlBridgeError('aborted', 'control request was aborted')
  }
  const socketPath = resolveSocketPath()
  const leaseToken = requiredEnv('ORPHEUS_RUNTIME_LEASE_TOKEN')
  const body = JSON.stringify(request)

  const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    let settled = false
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = (): void => {
      req.destroy(new ControlBridgeError('aborted', 'control request was aborted'))
    }
    const req = http.request(
      {
        socketPath,
        method: 'POST',
        path: '/control',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-orpheus-runtime-lease': leaseToken
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > RESPONSE_SIZE_LIMIT) {
            req.destroy(new Error('control response exceeds size limit'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          finish(resolve, {
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`control request timed out after ${REQUEST_TIMEOUT_MS}ms`))
    })
    req.on('error', (error) => finish(reject, error))
    signal?.addEventListener('abort', onAbort, { once: true })
    req.end(body)
  })

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    throw new ControlBridgeError(
      'protocol',
      `control endpoint returned non-JSON response (HTTP ${response.statusCode})`
    )
  }

  return parseControlEnvelope(parsed)
}

function unwrap(envelope: ControlEnvelope): unknown {
  if (envelope.ok) return envelope.data
  throw new ControlBridgeError(envelope.error.code, envelope.error.message)
}

export async function getCatalog(): Promise<ControlCatalog> {
  const data = unwrap(
    await postControl({ protocolVersion: CONTROL_PROTOCOL_VERSION, op: 'catalog' })
  )
  return parseCatalog(data)
}

export async function listCapabilities(): Promise<ControlCapability[]> {
  return (await getCatalog()).capabilities
}

export async function waitForCatalogChange(
  afterRevision: number,
  signal?: AbortSignal
): Promise<ControlCatalogWait> {
  const data = unwrap(
    await postControl(
      {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        op: 'catalog.wait',
        afterRevision
      },
      signal
    )
  )
  return parseCatalogWait(data)
}

export async function invokeCapability(id: string, input: unknown): Promise<unknown> {
  return unwrap(
    await postControl({
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      op: 'invoke',
      id,
      input
    })
  )
}
