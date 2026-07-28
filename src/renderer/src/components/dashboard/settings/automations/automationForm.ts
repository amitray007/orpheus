import type {
  AutomationCatalog,
  AutomationChangedEvent,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationOperationCatalogEntry,
  AutomationScope
} from '@shared/types'

export const AUTOMATION_RUN_POLL_MS = 4_000

type JsonRecord = Record<string, unknown>

export type SimpleSchemaField =
  | Readonly<{
      kind: 'text'
      key: string
      label: string
      description: string | null
      required: boolean
      minLength?: number
      maxLength?: number
    }>
  | Readonly<{
      kind: 'number'
      key: string
      label: string
      description: string | null
      required: boolean
      integer: boolean
      minimum?: number
      maximum?: number
    }>
  | Readonly<{
      kind: 'boolean'
      key: string
      label: string
      description: string | null
      required: boolean
    }>
  | Readonly<{
      kind: 'enum'
      key: string
      label: string
      description: string | null
      required: boolean
      options: readonly string[]
    }>
  | Readonly<{
      kind: 'enum-list'
      key: string
      label: string
      description: string | null
      required: boolean
      options: readonly string[]
    }>

export type SchemaForm = Readonly<{
  fields: readonly SimpleSchemaField[]
  constants: Readonly<Record<string, unknown>>
  unsupported: readonly string[]
}>

export type AutomationFormState = {
  name: string
  operationId: string
  params: Record<string, unknown>
  projectId: string
  workspaceId: string
  triggerKind: 'schedule' | 'event'
  intervalMs: number
  eventType: string
  timeoutMs: number
  concurrencyLimit: number
  retryMaxAttempts: number
  retryBaseDelayMs: number
  retryMaxDelayMs: number
  retryMaxElapsedMs: number
  rollingWindowMs: number
  rollingMaxStarts: number
}

export type FormValidation = Readonly<{
  valid: boolean
  errors: readonly string[]
}>

export type DefinitionReconciliation = Readonly<{
  definitions: readonly AutomationDefinition[]
  preservedDirtySelection: boolean
}>

export type AutomationNavigationTarget =
  | Readonly<{ kind: 'select'; id: string }>
  | Readonly<{ kind: 'create' | 'cancel-create' | 'runs' }>

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function humanize(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .trim()
  return spaced.length === 0 ? value : spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function fieldLabel(key: string, schema: JsonRecord): string {
  return typeof schema['title'] === 'string' && schema['title'].trim().length > 0
    ? schema['title'].trim()
    : humanize(key)
}

function fieldDescription(schema: JsonRecord): string | null {
  return typeof schema['description'] === 'string' && schema['description'].trim().length > 0
    ? schema['description'].trim()
    : null
}

// The schema catalog is a compact discriminated interpreter: each supported JSON Schema
// shape has its own safe rendering branch and everything else is rejected.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function operationSchemaForm(operation: AutomationOperationCatalogEntry): SchemaForm {
  const schema = operation.inputSchema
  const properties = isRecord(schema['properties']) ? schema['properties'] : {}
  const required = new Set(stringArray(schema['required']) ?? [])
  const fields: SimpleSchemaField[] = []
  const constants: Record<string, unknown> = {}
  const unsupported: string[] = []

  for (const [key, rawSchema] of Object.entries(properties)) {
    if (key === operation.scope.inputField) continue
    if (!isRecord(rawSchema)) {
      unsupported.push(key)
      continue
    }
    if (Object.hasOwn(rawSchema, 'const')) {
      constants[key] = rawSchema['const']
      continue
    }

    const label = fieldLabel(key, rawSchema)
    const description = fieldDescription(rawSchema)
    const isRequired = required.has(key)
    const enumOptions = stringArray(rawSchema['enum'])
    if (enumOptions != null && enumOptions.length > 0) {
      fields.push({
        kind: 'enum',
        key,
        label,
        description,
        required: isRequired,
        options: enumOptions
      })
      continue
    }

    switch (rawSchema['type']) {
      case 'string':
        fields.push({
          kind: 'text',
          key,
          label,
          description,
          required: isRequired,
          minLength: numberValue(rawSchema['minLength']),
          maxLength: numberValue(rawSchema['maxLength'])
        })
        break
      case 'integer':
      case 'number':
        fields.push({
          kind: 'number',
          key,
          label,
          description,
          required: isRequired,
          integer: rawSchema['type'] === 'integer',
          minimum: numberValue(rawSchema['minimum']),
          maximum: numberValue(rawSchema['maximum'])
        })
        break
      case 'boolean':
        fields.push({
          kind: 'boolean',
          key,
          label,
          description,
          required: isRequired
        })
        break
      case 'array': {
        const items = isRecord(rawSchema['items']) ? rawSchema['items'] : null
        const options = items == null ? null : stringArray(items['enum'])
        if (options == null || options.length === 0) {
          unsupported.push(key)
          break
        }
        fields.push({
          kind: 'enum-list',
          key,
          label,
          description,
          required: isRequired,
          options
        })
        break
      }
      default:
        unsupported.push(key)
    }
  }

  return { fields, constants, unsupported }
}

function initialParams(operation: AutomationOperationCatalogEntry): Record<string, unknown> {
  const form = operationSchemaForm(operation)
  const params: Record<string, unknown> = { ...form.constants }
  const properties = isRecord(operation.inputSchema['properties'])
    ? operation.inputSchema['properties']
    : {}
  for (const field of form.fields) {
    const rawSchema = properties[field.key]
    const schema: JsonRecord = isRecord(rawSchema) ? rawSchema : {}
    if (Object.hasOwn(schema, 'default')) {
      params[field.key] = schema['default']
    } else if (field.kind === 'boolean') {
      params[field.key] = false
    } else if (field.kind === 'enum-list') {
      params[field.key] = []
    } else if (field.kind === 'enum' && field.required) {
      params[field.key] = field.options[0] ?? ''
    }
  }
  return params
}

function boundedMinute(limits: AutomationCatalog['limits']['intervalMs']): number {
  return Math.min(limits.max, Math.max(limits.min, 60_000))
}

export function emptyAutomationForm(
  catalog: AutomationCatalog,
  operationId = catalog.operations[0]?.id ?? ''
): AutomationFormState {
  const operation = catalog.operations.find((item) => item.id === operationId)
  return {
    name: '',
    operationId: operation?.id ?? '',
    params: operation == null ? {} : initialParams(operation),
    projectId: '',
    workspaceId: '',
    triggerKind: 'schedule',
    intervalMs: boundedMinute(catalog.limits.intervalMs),
    eventType: catalog.eventTypes[0] ?? '',
    timeoutMs: catalog.defaults.timeoutMs,
    concurrencyLimit: catalog.defaults.concurrencyLimit,
    retryMaxAttempts: catalog.defaults.retry.maxAttempts,
    retryBaseDelayMs: catalog.defaults.retry.baseDelayMs,
    retryMaxDelayMs: catalog.defaults.retry.maxDelayMs,
    retryMaxElapsedMs: catalog.defaults.retry.maxElapsedMs,
    rollingWindowMs: catalog.defaults.rollingBudget.windowMs,
    rollingMaxStarts: catalog.defaults.rollingBudget.maxStarts
  }
}

export function automationFormFromDefinition(
  definition: AutomationDefinition
): AutomationFormState {
  return {
    name: definition.name,
    operationId: definition.operationId,
    params:
      isRecord(definition.params) && !Array.isArray(definition.params)
        ? { ...definition.params }
        : {},
    projectId: definition.scope.kind === 'app' ? '' : definition.scope.projectId,
    workspaceId: definition.scope.kind === 'workspace' ? definition.scope.workspaceId : '',
    triggerKind: definition.trigger.kind,
    intervalMs: definition.trigger.kind === 'schedule' ? definition.trigger.intervalMs : 60_000,
    eventType: definition.trigger.kind === 'event' ? definition.trigger.eventType : '',
    timeoutMs: definition.timeoutMs,
    concurrencyLimit: definition.concurrencyLimit,
    retryMaxAttempts: definition.retry.maxAttempts,
    retryBaseDelayMs: definition.retry.baseDelayMs,
    retryMaxDelayMs: definition.retry.maxDelayMs,
    retryMaxElapsedMs: definition.retry.maxElapsedMs,
    rollingWindowMs: definition.rollingBudget.windowMs,
    rollingMaxStarts: definition.rollingBudget.maxStarts
  }
}

export function resetOperation(
  state: AutomationFormState,
  operation: AutomationOperationCatalogEntry
): AutomationFormState {
  return {
    ...state,
    operationId: operation.id,
    params: initialParams(operation),
    workspaceId:
      operation.scope.kind === 'workspace' || operation.scope.kind === 'self'
        ? state.workspaceId
        : ''
  }
}

function scopeFor(
  operation: AutomationOperationCatalogEntry,
  state: AutomationFormState
): AutomationScope | null {
  if (operation.scope.kind === 'project') {
    return state.projectId.length > 0 ? { kind: 'project', projectId: state.projectId } : null
  }
  if (operation.scope.kind === 'workspace' || operation.scope.kind === 'self') {
    return state.projectId.length > 0 && state.workspaceId.length > 0
      ? {
          kind: 'workspace',
          projectId: state.projectId,
          workspaceId: state.workspaceId
        }
      : null
  }
  return null
}

function paramsFor(
  operation: AutomationOperationCatalogEntry,
  state: AutomationFormState,
  scope: AutomationScope
): Record<string, unknown> {
  const form = operationSchemaForm(operation)
  const params: Record<string, unknown> = { ...form.constants }
  for (const field of form.fields) {
    const value = state.params[field.key]
    if (
      value !== undefined &&
      value !== '' &&
      !(Array.isArray(value) && value.length === 0 && !field.required)
    ) {
      params[field.key] = value
    }
  }
  const inputField = operation.scope.inputField
  if (inputField != null) {
    if (
      (operation.scope.kind === 'workspace' || operation.scope.kind === 'self') &&
      scope.kind === 'workspace'
    ) {
      params[inputField] = scope.workspaceId
    } else if (operation.scope.kind === 'project' && scope.kind !== 'app') {
      params[inputField] = scope.projectId
    }
  }
  return params
}

function inRange(value: number, bounds: Readonly<{ min: number; max: number }>): boolean {
  return Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max
}

// Keep all cross-field budget and scope invariants in one deterministic validator so
// the UI and verifier cannot drift into separate acceptance rules.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function validateAutomationForm(
  catalog: AutomationCatalog,
  state: AutomationFormState
): FormValidation {
  const errors: string[] = []
  const operation = catalog.operations.find((item) => item.id === state.operationId)
  if (state.name.trim().length === 0 || state.name.trim() !== state.name) {
    errors.push('Enter a name without leading or trailing spaces.')
  }
  if (state.name.length > 120) errors.push('Keep the name to 120 characters or fewer.')
  if (operation == null) {
    errors.push('Choose an available operation.')
    return { valid: false, errors }
  }
  const schemaForm = operationSchemaForm(operation)
  if (schemaForm.unsupported.length > 0) {
    errors.push('This operation contains parameters that this safe editor cannot represent.')
  }
  if (scopeFor(operation, state) == null) {
    errors.push(
      operation.scope.kind === 'workspace' || operation.scope.kind === 'self'
        ? 'Choose a project and workspace.'
        : operation.scope.kind === 'project'
          ? 'Choose a project.'
          : 'This operation scope is not supported by the editor.'
    )
  }
  for (const field of schemaForm.fields) {
    const value = state.params[field.key]
    if (
      field.required &&
      (value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
    ) {
      errors.push(`${field.label} is required.`)
    }
    if (field.kind === 'number' && value !== undefined) {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.integer && !Number.isInteger(value)) ||
        (field.minimum !== undefined && value < field.minimum) ||
        (field.maximum !== undefined && value > field.maximum)
      ) {
        errors.push(`${field.label} is outside its allowed range.`)
      }
    }
  }
  if (state.triggerKind === 'event') {
    if (!catalog.eventTypes.includes(state.eventType)) {
      errors.push('Choose an available event type.')
    }
  } else if (!inRange(state.intervalMs, catalog.limits.intervalMs)) {
    errors.push('Schedule interval is outside its allowed range.')
  }
  if (!inRange(state.timeoutMs, catalog.limits.timeoutMs)) {
    errors.push('Timeout is outside its allowed range.')
  }
  if (!inRange(state.concurrencyLimit, catalog.limits.concurrencyLimit)) {
    errors.push('Concurrency is outside its allowed range.')
  }
  if (!inRange(state.retryMaxAttempts, catalog.limits.retryMaxAttempts)) {
    errors.push('Retry attempts are outside the allowed range.')
  }
  if (
    !inRange(state.retryBaseDelayMs, catalog.limits.retryBaseDelayMs) ||
    !inRange(state.retryMaxDelayMs, catalog.limits.retryMaxDelayMs) ||
    state.retryMaxDelayMs < state.retryBaseDelayMs
  ) {
    errors.push('Retry delays are outside their allowed range.')
  }
  if (
    !inRange(state.retryMaxElapsedMs, catalog.limits.runMaxElapsedMs) ||
    state.retryMaxElapsedMs < state.timeoutMs
  ) {
    errors.push('Maximum elapsed time must be at least the timeout.')
  }
  if (!inRange(state.rollingWindowMs, catalog.limits.rollingWindowMs)) {
    errors.push('Rolling window is outside its allowed range.')
  }
  if (!inRange(state.rollingMaxStarts, catalog.limits.rollingMaxStarts)) {
    errors.push('Rolling start limit is outside its allowed range.')
  }
  return { valid: errors.length === 0, errors }
}

export function buildAutomationDraft(
  catalog: AutomationCatalog,
  state: AutomationFormState
): AutomationDefinitionDraft | null {
  if (!validateAutomationForm(catalog, state).valid) return null
  const operation = catalog.operations.find((item) => item.id === state.operationId)
  if (operation == null) return null
  const scope = scopeFor(operation, state)
  if (scope == null) return null
  return {
    name: state.name,
    operationId: operation.id,
    params: paramsFor(operation, state, scope),
    scope,
    trigger:
      state.triggerKind === 'schedule'
        ? { kind: 'schedule', intervalMs: state.intervalMs }
        : { kind: 'event', eventType: state.eventType },
    enabled: false,
    idempotency: operation.idempotency,
    timeoutMs: state.timeoutMs,
    concurrencyLimit: state.concurrencyLimit,
    retry: {
      maxAttempts: state.retryMaxAttempts,
      baseDelayMs: state.retryBaseDelayMs,
      maxDelayMs: state.retryMaxDelayMs,
      maxElapsedMs: state.retryMaxElapsedMs
    },
    rollingBudget: {
      windowMs: state.rollingWindowMs,
      maxStarts: state.rollingMaxStarts
    }
  }
}

export function automationFormIsDirty(
  initial: AutomationFormState,
  current: AutomationFormState
): boolean {
  return JSON.stringify(initial) !== JSON.stringify(current)
}

export function reconcileAutomationDefinitions(
  incoming: readonly AutomationDefinition[],
  dirtySelection: AutomationDefinition | null
): DefinitionReconciliation {
  if (dirtySelection == null) {
    return { definitions: incoming, preservedDirtySelection: false }
  }
  const refreshed = incoming.find((item) => item.id === dirtySelection.id)
  if (refreshed?.updatedAt === dirtySelection.updatedAt) {
    return { definitions: incoming, preservedDirtySelection: false }
  }
  const definitions = incoming.some((item) => item.id === dirtySelection.id)
    ? incoming.map((item) => (item.id === dirtySelection.id ? dirtySelection : item))
    : [dirtySelection, ...incoming]
  return { definitions, preservedDirtySelection: true }
}

export function shouldConfirmAutomationNavigation(
  dirty: boolean,
  selectedId: string | null,
  target: AutomationNavigationTarget
): boolean {
  if (!dirty) return false
  return target.kind !== 'select' || target.id !== selectedId
}

export function nextSelectedAutomationId(
  definitions: readonly AutomationDefinition[],
  selectedId: string | null
): string | null {
  if (selectedId != null && definitions.some((item) => item.id === selectedId)) {
    return selectedId
  }
  return definitions[0]?.id ?? null
}

export function shouldRefreshSelectedRuns(
  event: AutomationChangedEvent,
  selectedId: string | null
): boolean {
  return selectedId != null && event.definitionId === selectedId
}
