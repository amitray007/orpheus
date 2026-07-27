import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { WorkspaceRecord } from '../../shared/types'
import {
  RESOURCES_LIST_PROJECT_METADATA_ID,
  SETTINGS_GET_EFFECTIVE_ID
} from '../controlPlane/settingsResourceService'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationManagementContext
} from './types'
import type { AutomationScheduler } from './scheduler'
import type { AutomationService } from './service'
import { WORKSPACE_COMPLETED_EVENT } from './workspaceEvents'

export const PHASE8_QA_COMMAND = 'automations.phase8Qa'
export const PHASE8_QA_TOKEN_HEADER = 'x-orpheus-phase8-qa-token'
export const PHASE8_QA_ENV_KEYS = [
  'ORPHEUS_PHASE8_QA',
  'ORPHEUS_PHASE8_QA_WORKSPACE_ID',
  'ORPHEUS_PHASE8_QA_TOKEN'
] as const
export const PHASE8_QA_ACTIONS = [
  'createSchedule',
  'createEvent',
  'enable',
  'status',
  'disable',
  'cleanup'
] as const

export type Phase8QaAction = (typeof PHASE8_QA_ACTIONS)[number]
export type Phase8QaArgs =
  | Readonly<{ fixtureAction: 'createSchedule' | 'createEvent' | 'cleanup' }>
  | Readonly<{ fixtureAction: 'enable' | 'status' | 'disable'; definitionId: string }>

export type Phase8QaConfig = Readonly<{
  workspaceId: string
  credential: string
  principalId: string
}>

export type Phase8QaController = {
  execute: (args: unknown) => Promise<Phase8QaResult>
}

export type Phase8QaResult = {
  definition?: {
    id: string
    name: string
    operationId: string
    enabled: boolean
    projectId: string
    workspaceId: string
  }
  reused?: boolean
  cleanedDefinitionIds?: string[]
  runs?: Array<{
    id: string
    status: string
    requestId: string | null
    auditId: string | null
    resultCode: string | null
  }>
}

type Phase8QaDeps = {
  service: AutomationService
  scheduler: AutomationScheduler
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null | undefined
  targetWorkspaceId: string
  principalId: string
  generateId?: () => string
}

const SCHEDULE_NAME = 'Phase 8 QA settings schedule'
const EVENT_NAME = 'Phase 8 QA workspace completion'
const COMMON_BOUNDS = Object.freeze({
  timeoutMs: 5_000,
  concurrencyLimit: 1,
  retry: Object.freeze({
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    maxElapsedMs: 10_000
  }),
  rollingBudget: Object.freeze({
    windowMs: 60_000,
    maxStarts: 10
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 128 && value.trim() === value
  )
}

export function parsePhase8QaArgs(value: unknown): Phase8QaArgs | null {
  if (!isRecord(value) || typeof value['fixtureAction'] !== 'string') return null
  const action = value['fixtureAction']
  if (action === 'createSchedule' || action === 'createEvent' || action === 'cleanup') {
    return hasOnlyKeys(value, ['fixtureAction']) ? { fixtureAction: action } : null
  }
  if (action === 'enable' || action === 'status' || action === 'disable') {
    return hasOnlyKeys(value, ['fixtureAction', 'definitionId']) && validId(value['definitionId'])
      ? { fixtureAction: action, definitionId: value['definitionId'] }
      : null
  }
  return null
}

export function phase8QaGateEnabled(envValue: string | undefined, appName: string): boolean {
  return envValue === '1' && appName === 'Orpheus Dev'
}

function plausibleHighEntropyCredential(value: string | undefined): value is string {
  if (value == null || value.length < 43 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false
  }
  return new Set(value).size >= 16
}

/**
 * Capture the Dev-only QA configuration once, then delete every source value
 * so native terminal mounts cannot inherit QA credentials or target config.
 */
export function capturePhase8QaConfig(
  env: Record<string, string | undefined>,
  appName: string
): Phase8QaConfig | null {
  const flag = env[PHASE8_QA_ENV_KEYS[0]]
  const workspaceId = env[PHASE8_QA_ENV_KEYS[1]]
  const credential = env[PHASE8_QA_ENV_KEYS[2]]
  for (const key of PHASE8_QA_ENV_KEYS) delete env[key]
  if (
    !phase8QaGateEnabled(flag, appName) ||
    !validId(workspaceId) ||
    !plausibleHighEntropyCredential(credential)
  ) {
    return null
  }
  const fingerprint = createHash('sha256').update(credential, 'utf8').digest('hex').slice(0, 16)
  return {
    workspaceId,
    credential,
    principalId: `phase8-qa:${fingerprint}`
  }
}

export function phase8QaCredentialMatches(
  incomingCredential: string | string[] | undefined,
  expectedCredential: string
): boolean {
  if (typeof incomingCredential !== 'string') return false
  const incoming = Buffer.from(incomingCredential, 'utf8')
  const expected = Buffer.from(expectedCredential, 'utf8')
  return incoming.length === expected.length && timingSafeEqual(incoming, expected)
}

function scheduleDraft(workspace: WorkspaceRecord): AutomationDefinitionDraft {
  return {
    name: SCHEDULE_NAME,
    trigger: { kind: 'schedule', intervalMs: 1_000 },
    operationId: SETTINGS_GET_EFFECTIVE_ID,
    params: { workspaceId: workspace.id },
    scope: {
      kind: 'workspace',
      projectId: workspace.projectId,
      workspaceId: workspace.id
    },
    enabled: false,
    idempotency: 'natural',
    ...COMMON_BOUNDS
  }
}

function eventDraft(workspace: WorkspaceRecord): AutomationDefinitionDraft {
  return {
    name: EVENT_NAME,
    trigger: { kind: 'event', eventType: WORKSPACE_COMPLETED_EVENT },
    operationId: RESOURCES_LIST_PROJECT_METADATA_ID,
    params: { projectId: workspace.projectId },
    scope: {
      kind: 'workspace',
      projectId: workspace.projectId,
      workspaceId: workspace.id
    },
    enabled: false,
    idempotency: 'natural',
    ...COMMON_BOUNDS
  }
}

function paramsMatch(definition: AutomationDefinition): boolean {
  if (!isRecord(definition.params)) return false
  if (definition.operationId === SETTINGS_GET_EFFECTIVE_ID) {
    return (
      definition.scope.kind === 'workspace' &&
      hasOnlyKeys(definition.params, ['workspaceId']) &&
      definition.params['workspaceId'] === definition.scope.workspaceId
    )
  }
  return (
    definition.operationId === RESOURCES_LIST_PROJECT_METADATA_ID &&
    definition.scope.kind === 'workspace' &&
    hasOnlyKeys(definition.params, ['projectId']) &&
    definition.params['projectId'] === definition.scope.projectId
  )
}

function isFixedQaDefinition(
  definition: AutomationDefinition,
  targetWorkspaceId?: string
): boolean {
  const schedule =
    definition.name === SCHEDULE_NAME &&
    definition.operationId === SETTINGS_GET_EFFECTIVE_ID &&
    definition.trigger.kind === 'schedule' &&
    definition.trigger.intervalMs === 1_000
  const event =
    definition.name === EVENT_NAME &&
    definition.operationId === RESOURCES_LIST_PROJECT_METADATA_ID &&
    definition.trigger.kind === 'event' &&
    definition.trigger.eventType === WORKSPACE_COMPLETED_EVENT
  return (
    (schedule || event) &&
    definition.scope.kind === 'workspace' &&
    (targetWorkspaceId == null || definition.scope.workspaceId === targetWorkspaceId) &&
    definition.idempotency === 'natural' &&
    definition.timeoutMs === COMMON_BOUNDS.timeoutMs &&
    definition.concurrencyLimit === COMMON_BOUNDS.concurrencyLimit &&
    definition.retry.maxAttempts === COMMON_BOUNDS.retry.maxAttempts &&
    definition.retry.baseDelayMs === COMMON_BOUNDS.retry.baseDelayMs &&
    definition.retry.maxDelayMs === COMMON_BOUNDS.retry.maxDelayMs &&
    definition.retry.maxElapsedMs === COMMON_BOUNDS.retry.maxElapsedMs &&
    definition.rollingBudget.windowMs === COMMON_BOUNDS.rollingBudget.windowMs &&
    definition.rollingBudget.maxStarts === COMMON_BOUNDS.rollingBudget.maxStarts &&
    paramsMatch(definition)
  )
}

function managementContext(
  generateId: () => string,
  principalId: string
): AutomationManagementContext {
  return {
    requestId: `phase8-qa:${generateId()}`,
    principal: { type: 'cli' as const, id: principalId },
    consumer: 'command-socket' as const
  }
}

function definitionSummary(
  definition: AutomationDefinition
): NonNullable<Phase8QaResult['definition']> {
  if (definition.scope.kind !== 'workspace') {
    throw new Error('Phase 8 QA fixture must remain workspace-scoped.')
  }
  return {
    id: definition.id,
    name: definition.name,
    operationId: definition.operationId,
    enabled: definition.enabled,
    projectId: definition.scope.projectId,
    workspaceId: definition.scope.workspaceId
  }
}

export function createPhase8QaController(deps: Phase8QaDeps): Phase8QaController {
  const generateId = deps.generateId ?? randomUUID
  const fixtureWorkspace = (): WorkspaceRecord => {
    const workspace = deps.getWorkspace(deps.targetWorkspaceId)
    if (workspace == null || workspace.id !== deps.targetWorkspaceId) {
      throw new Error('Configured Phase 8 QA workspace was not found.')
    }
    return workspace
  }
  const fixedDefinition = (id: string): AutomationDefinition => {
    const definition = deps.service.getDefinition(id)
    if (!isFixedQaDefinition(definition, deps.targetWorkspaceId)) {
      throw new Error('Definition is not a fixed Phase 8 QA fixture.')
    }
    const workspace =
      definition.scope.kind === 'workspace' ? deps.getWorkspace(definition.scope.workspaceId) : null
    if (
      workspace == null ||
      definition.scope.kind !== 'workspace' ||
      workspace.projectId !== definition.scope.projectId
    ) {
      throw new Error('Phase 8 QA fixture scope is no longer valid.')
    }
    return definition
  }

  const execute = async (rawArgs: unknown): Promise<Phase8QaResult> => {
    const args = parsePhase8QaArgs(rawArgs)
    if (args == null) throw new Error('Invalid Phase 8 QA fixture request.')
    if (args.fixtureAction === 'createSchedule' || args.fixtureAction === 'createEvent') {
      const workspace = fixtureWorkspace()
      const existing = deps.service.listDefinitions().find((definition) => {
        if (!isFixedQaDefinition(definition, workspace.id)) return false
        return args.fixtureAction === 'createSchedule'
          ? definition.trigger.kind === 'schedule'
          : definition.trigger.kind === 'event'
      })
      if (existing != null) {
        return { definition: definitionSummary(existing), reused: true }
      }
      const definition = await deps.service.createDefinition(
        args.fixtureAction === 'createSchedule' ? scheduleDraft(workspace) : eventDraft(workspace),
        managementContext(generateId, deps.principalId)
      )
      return { definition: definitionSummary(definition), reused: false }
    }

    if (args.fixtureAction === 'cleanup') {
      fixtureWorkspace()
      const fixtures = deps.service
        .listDefinitions()
        .filter((definition) => isFixedQaDefinition(definition, deps.targetWorkspaceId))
      for (const definition of fixtures) {
        deps.scheduler.deleteDefinition(
          definition.id,
          managementContext(generateId, deps.principalId)
        )
      }
      return { cleanedDefinitionIds: fixtures.map(({ id }) => id) }
    }

    if (!('definitionId' in args)) {
      throw new Error('Invalid Phase 8 QA fixture definition request.')
    }
    const definition = fixedDefinition(args.definitionId)
    if (args.fixtureAction === 'status') {
      return {
        definition: definitionSummary(definition),
        runs: deps.service.listRuns(definition.id, 50).map((run) => ({
          id: run.id,
          status: run.status,
          requestId: run.requestId,
          auditId: run.auditId,
          resultCode: run.resultCode
        }))
      }
    }
    const enabled = args.fixtureAction === 'enable'
    const updated = await deps.scheduler.setEnabled(
      definition.id,
      enabled,
      managementContext(generateId, deps.principalId)
    )
    return { definition: definitionSummary(updated) }
  }

  // The Dev QA protocol deliberately has one controller. Serialize every
  // management/read action so create/reuse, cleanup, enable/disable, and
  // status cannot interleave and observe half-completed fixture lifecycle.
  let actionQueue: Promise<void> = Promise.resolve()
  return {
    execute(rawArgs) {
      const result = actionQueue.then(() => execute(rawArgs))
      actionQueue = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
  }
}
