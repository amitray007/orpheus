export const CONTROL_PROTOCOL_VERSION = 1 as const

export type JsonSchema = Record<string, unknown>

export type ControlCapability = {
  id: string
  version: 1
  kind: 'query' | 'mutation'
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
}

export type ControlRequest =
  | { protocolVersion: 1; op: 'catalog' }
  | { protocolVersion: 1; op: 'catalog.wait'; afterRevision: number }
  | { protocolVersion: 1; op: 'invoke'; id: string; input: unknown }

export type ControlError = {
  code: string
  message: string
}

export type ControlEnvelope = { ok: true; data: unknown } | { ok: false; error: ControlError }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isCapability(value: unknown): value is ControlCapability {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.version === 1 &&
    (value.kind === 'query' || value.kind === 'mutation') &&
    typeof value.description === 'string' &&
    isRecord(value.inputSchema) &&
    value.inputSchema.type === 'object' &&
    isRecord(value.outputSchema)
  )
}

export function parseControlEnvelope(value: unknown): ControlEnvelope {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('invalid control response envelope')
  }
  if (value.ok) {
    if (!Object.hasOwn(value, 'data')) throw new Error('control response is missing data')
    return { ok: true, data: value.data }
  }
  if (
    !isRecord(value.error) ||
    typeof value.error.code !== 'string' ||
    typeof value.error.message !== 'string'
  ) {
    throw new Error('invalid control error envelope')
  }
  return {
    ok: false,
    error: { code: value.error.code, message: value.error.message }
  }
}

export type ControlCatalog = {
  revision: number
  capabilities: ControlCapability[]
}

export type ControlCatalogWait = {
  revision: number
  changed: boolean
}

export function parseCatalog(value: unknown): ControlCatalog {
  if (
    !isRecord(value) ||
    value.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(isCapability) ||
    !Object.keys(value).every((key) =>
      ['protocolVersion', 'revision', 'capabilities'].includes(key)
    )
  ) {
    throw new Error('invalid or unsupported control catalog')
  }

  const capabilities = value.capabilities
  const names = new Set(capabilities.map((capability) => capability.id))
  if (names.size !== capabilities.length) {
    throw new Error('control catalog contains duplicate capability ids')
  }
  return { revision: value.revision as number, capabilities }
}

export function parseCatalogWait(value: unknown): ControlCatalogWait {
  if (
    !isRecord(value) ||
    value.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.changed !== 'boolean' ||
    !Object.keys(value).every((key) => ['protocolVersion', 'revision', 'changed'].includes(key))
  ) {
    throw new Error('invalid or unsupported control catalog wait response')
  }
  return { revision: value.revision as number, changed: value.changed }
}
