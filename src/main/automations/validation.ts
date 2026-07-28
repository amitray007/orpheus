import type { ControlDescription } from '../controlPlane/types'
import type { AutomationOperationCatalogEntry } from '../../shared/types'
import {
  AUTOMATION_LIMITS,
  type AutomationDefinitionDraft,
  type AutomationEvent,
  type AutomationScope
} from './types'

const SECRET_FIELD =
  /(?:token|secret|password|authorization|cookie|lease|credential|api[_-]?key|access[_-]?key|private[_-]?key|environment|env|bytes|sequence|keycode)/i
const SECRET_VALUE =
  /(?:bearer\s+\S+|(?:api[_-]?key|token|secret|password|authorization|cookie|lease)\s*[:=]\s*\S+|(?:sk|ghp|github_pat|xox[aboprs])[-_][A-Za-z0-9_-]{8,})/i
const MAX_CATALOG_SCHEMA_BYTES = 256 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function containsSecretField(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return SECRET_VALUE.test(value)
  if (value == null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => containsSecretField(item, seen))
  return Object.entries(value).some(
    ([key, child]) => SECRET_FIELD.test(key) || containsSecretField(child, seen)
  )
}

function isSafeIntegerBetween(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function validId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && value.trim() === value
}

function safeSchema(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(value)
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > MAX_CATALOG_SCHEMA_BYTES
  ) {
    throw new Error('Automation operation schema is not safely serializable.')
  }
  const parsed: unknown = JSON.parse(serialized)
  if (!isRecord(parsed)) throw new Error('Automation operation schema is invalid.')
  return parsed
}

function editorSupportsField(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  if (Object.hasOwn(schema, 'const')) return true
  const options = schema['enum']
  if (Array.isArray(options)) {
    return options.length > 0 && options.every((option) => typeof option === 'string')
  }
  if (schema['type'] === 'array') {
    const items = schema['items']
    return (
      isRecord(items) &&
      Array.isArray(items['enum']) &&
      items['enum'].length > 0 &&
      items['enum'].every((option) => typeof option === 'string')
    )
  }
  return ['string', 'integer', 'number', 'boolean'].includes(String(schema['type']))
}

/**
 * Keep the server-published catalog within the renderer's deliberately small
 * safe form language. A descriptor may remain automation-invocable by an
 * already persisted definition while being withheld from new-definition UI.
 */
export function automationEditorSupportsDescription(description: ControlDescription): boolean {
  if (!['self', 'project', 'workspace'].includes(description.scope.kind)) return false
  const schema = description.inputSchema
  if (
    schema['type'] !== 'object' ||
    schema['additionalProperties'] !== false ||
    ['oneOf', 'anyOf', 'allOf', 'if', 'then', 'else'].some((key) => Object.hasOwn(schema, key))
  ) {
    return false
  }
  const properties = schema['properties']
  if (!isRecord(properties)) return false
  const scopeField =
    'inputField' in description.scope ? (description.scope.inputField ?? null) : null
  return Object.entries(properties).every(
    ([key, fieldSchema]) => key === scopeField || editorSupportsField(fieldSchema)
  )
}

export function automationCatalogEntry(
  description: ControlDescription
): AutomationOperationCatalogEntry | null {
  if (
    !description.allowedSurfaces.includes('automation') ||
    description.idempotency == null ||
    !automationEditorSupportsDescription(description)
  ) {
    return null
  }
  return {
    id: description.id,
    version: description.version,
    kind: description.kind,
    description: description.description,
    inputSchema: safeSchema(description.inputSchema),
    outputSchema: safeSchema(description.outputSchema),
    permission: description.permission,
    scope: {
      kind: description.scope.kind,
      ...('inputField' in description.scope && description.scope.inputField !== undefined
        ? { inputField: description.scope.inputField }
        : {})
    },
    risk: { ...description.risk },
    declaredEffects: [...(description.declaredEffects ?? [])],
    idempotency: description.idempotency
  }
}

export function validateAutomationScope(scope: AutomationScope): boolean {
  if (scope.kind === 'app') return Object.keys(scope).length === 1
  if (!validId(scope.projectId)) return false
  if (scope.kind === 'project') return Object.keys(scope).length === 2
  return validId(scope.workspaceId) && Object.keys(scope).length === 3
}

export function validateAutomationDraft(
  draft: AutomationDefinitionDraft,
  allowedEventTypes: ReadonlySet<string>
): string | null {
  if (
    draft.name.trim() !== draft.name ||
    draft.name.length < 1 ||
    draft.name.length > AUTOMATION_LIMITS.maxNameLength
  ) {
    return 'Automation name is invalid.'
  }
  if (!validId(draft.operationId)) return 'Operation id is invalid.'
  if (!validateAutomationScope(draft.scope)) return 'Automation scope is invalid.'
  if (
    !isSafeIntegerBetween(
      draft.timeoutMs,
      AUTOMATION_LIMITS.minTimeoutMs,
      AUTOMATION_LIMITS.maxTimeoutMs
    )
  ) {
    return 'Automation timeout is outside the allowed range.'
  }
  if (!isSafeIntegerBetween(draft.concurrencyLimit, 1, AUTOMATION_LIMITS.maxConcurrency)) {
    return 'Automation concurrency limit is invalid.'
  }
  if (!isSafeIntegerBetween(draft.retry.maxAttempts, 1, AUTOMATION_LIMITS.maxAttempts)) {
    return 'Automation retry attempt limit is invalid.'
  }
  if (
    !isSafeIntegerBetween(
      draft.retry.baseDelayMs,
      AUTOMATION_LIMITS.minRetryDelayMs,
      AUTOMATION_LIMITS.maxRetryBaseDelayMs
    ) ||
    !isSafeIntegerBetween(
      draft.retry.maxDelayMs,
      draft.retry.baseDelayMs,
      AUTOMATION_LIMITS.maxRetryDelayMs
    )
  ) {
    return 'Automation retry delay is invalid.'
  }
  if (
    !isSafeIntegerBetween(
      draft.retry.maxElapsedMs,
      draft.timeoutMs,
      AUTOMATION_LIMITS.maxRunElapsedMs
    )
  ) {
    return 'Automation run elapsed budget is invalid.'
  }
  if (
    !isSafeIntegerBetween(
      draft.rollingBudget.windowMs,
      AUTOMATION_LIMITS.minRollingWindowMs,
      AUTOMATION_LIMITS.maxRollingWindowMs
    ) ||
    !isSafeIntegerBetween(draft.rollingBudget.maxStarts, 1, AUTOMATION_LIMITS.maxRollingStarts)
  ) {
    return 'Automation rolling budget is invalid.'
  }
  if (draft.trigger.kind === 'schedule') {
    if (
      !isSafeIntegerBetween(
        draft.trigger.intervalMs,
        AUTOMATION_LIMITS.minIntervalMs,
        AUTOMATION_LIMITS.maxIntervalMs
      ) ||
      (draft.trigger.startAt !== undefined &&
        (!Number.isSafeInteger(draft.trigger.startAt) || draft.trigger.startAt < 0))
    ) {
      return 'Automation schedule trigger is invalid.'
    }
  } else if (
    draft.trigger.eventType.length < 1 ||
    draft.trigger.eventType.length > AUTOMATION_LIMITS.maxEventTypeLength ||
    !allowedEventTypes.has(draft.trigger.eventType)
  ) {
    return 'Automation event trigger is not allowlisted.'
  }
  try {
    if (containsSecretField(draft.params)) {
      return 'Automation params contain a forbidden secret-bearing field.'
    }
    const serialized = JSON.stringify(draft.params)
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 256 * 1_024) {
      return 'Automation params exceed the persisted size limit.'
    }
  } catch {
    return 'Automation params must be JSON serializable.'
  }
  return null
}

export function isAutomationDraft(
  value: unknown,
  allowedEventTypes: ReadonlySet<string>
): value is AutomationDefinitionDraft {
  return isAutomationDraftShape(value) && validateAutomationDraft(value, allowedEventTypes) == null
}

export function isAutomationDraftShape(value: unknown): value is AutomationDefinitionDraft {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      'name',
      'trigger',
      'operationId',
      'params',
      'scope',
      'enabled',
      'idempotency',
      'timeoutMs',
      'concurrencyLimit',
      'retry',
      'rollingBudget'
    ]) ||
    typeof value['name'] !== 'string' ||
    typeof value['operationId'] !== 'string' ||
    (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') ||
    !['none', 'keyed', 'natural'].includes(String(value['idempotency'])) ||
    typeof value['timeoutMs'] !== 'number' ||
    typeof value['concurrencyLimit'] !== 'number' ||
    !isRecord(value['trigger']) ||
    !isRecord(value['scope']) ||
    !isRecord(value['retry']) ||
    !isRecord(value['rollingBudget'])
  ) {
    return false
  }
  const trigger = value['trigger']
  if (
    (trigger['kind'] === 'schedule' &&
      (!onlyKeys(trigger, ['kind', 'intervalMs', 'startAt']) ||
        typeof trigger['intervalMs'] !== 'number' ||
        (trigger['startAt'] !== undefined && typeof trigger['startAt'] !== 'number'))) ||
    (trigger['kind'] === 'event' &&
      (!onlyKeys(trigger, ['kind', 'eventType']) || typeof trigger['eventType'] !== 'string')) ||
    (trigger['kind'] !== 'schedule' && trigger['kind'] !== 'event')
  ) {
    return false
  }
  const scope = value['scope']
  if (
    !onlyKeys(scope, ['kind', 'projectId', 'workspaceId']) ||
    !['app', 'project', 'workspace'].includes(String(scope['kind'])) ||
    (scope['projectId'] !== undefined && typeof scope['projectId'] !== 'string') ||
    (scope['workspaceId'] !== undefined && typeof scope['workspaceId'] !== 'string')
  ) {
    return false
  }
  const retry = value['retry']
  const rolling = value['rollingBudget']
  if (
    !onlyKeys(retry, ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'maxElapsedMs']) ||
    !['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'maxElapsedMs'].every(
      (key) => typeof retry[key] === 'number'
    ) ||
    !onlyKeys(rolling, ['windowMs', 'maxStarts']) ||
    typeof rolling['windowMs'] !== 'number' ||
    typeof rolling['maxStarts'] !== 'number'
  ) {
    return false
  }
  return true
}

export function validateAutomationDescriptor(
  description: ControlDescription | null,
  requestedIdempotency: AutomationDefinitionDraft['idempotency']
): string | null {
  if (description == null || !description.allowedSurfaces.includes('automation')) {
    return 'Operation is not automation eligible.'
  }
  if (description.idempotency == null || description.idempotency !== requestedIdempotency) {
    return 'Automation idempotency must match the operation descriptor.'
  }
  return null
}

export function eventMatchesScope(event: AutomationEvent, scope: AutomationScope): boolean {
  if (scope.kind === 'app') return true
  if (event.projectId !== scope.projectId) return false
  return scope.kind === 'project' || event.workspaceId === scope.workspaceId
}
