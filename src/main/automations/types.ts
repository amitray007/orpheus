import type { ControlContext, ControlDescription, ControlResult } from '../controlPlane/types'
import type {
  AutomationDefinition as SharedAutomationDefinition,
  AutomationDefinitionDraft as SharedAutomationDefinitionDraft,
  AutomationIdempotency as SharedAutomationIdempotency,
  AutomationEditorConfiguration as SharedAutomationEditorConfiguration,
  AutomationManualRetryReason as SharedAutomationManualRetryReason,
  AutomationRunWithEligibility as SharedAutomationRunWithEligibility,
  AutomationRetryBudget as SharedAutomationRetryBudget,
  AutomationRollingBudget as SharedAutomationRollingBudget,
  AutomationRun as SharedAutomationRun,
  AutomationRunStatus as SharedAutomationRunStatus,
  AutomationScope as SharedAutomationScope,
  AutomationTrigger as SharedAutomationTrigger,
  AutomationTriggerOccurrence as SharedAutomationTriggerOccurrence
} from '../../shared/types'

export const AUTOMATION_LIMITS = Object.freeze({
  minIntervalMs: 1_000,
  maxIntervalMs: 30 * 24 * 60 * 60 * 1_000,
  minTimeoutMs: 100,
  maxTimeoutMs: 5 * 60 * 1_000,
  maxConcurrency: 8,
  maxAttempts: 8,
  minRetryDelayMs: 100,
  maxRetryBaseDelayMs: 60_000,
  maxRetryDelayMs: 60 * 60 * 1_000,
  maxRunElapsedMs: 24 * 60 * 60 * 1_000,
  minRollingWindowMs: 1_000,
  maxRollingWindowMs: 24 * 60 * 60 * 1_000,
  maxRollingStarts: 10_000,
  maxEventTypeLength: 128,
  maxNameLength: 120,
  maxListLimit: 200,
  maxDefinitions: 500,
  maxGlobalConcurrency: 8,
  maxEventFanout: 200,
  maxRetainedRunsPerAutomation: 1_000,
  runRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxRetainedDeliveredEvents: 10_000,
  eventRetentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxEventRetryDelayMs: 60 * 60 * 1_000
})

export const AUTOMATION_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  concurrencyLimit: 1,
  retry: Object.freeze({
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    maxElapsedMs: 15 * 60 * 1_000
  }),
  rollingBudget: Object.freeze({
    windowMs: 60_000,
    maxStarts: 60
  })
})

export type AutomationTrigger = SharedAutomationTrigger
export type AutomationScope = SharedAutomationScope
export type AutomationIdempotency = SharedAutomationIdempotency
export type AutomationRetryBudget = SharedAutomationRetryBudget
export type AutomationRollingBudget = SharedAutomationRollingBudget
export type AutomationDefinitionDraft = SharedAutomationDefinitionDraft
export type AutomationDefinition = SharedAutomationDefinition
export type AutomationRunStatus = SharedAutomationRunStatus
export type AutomationTriggerOccurrence = SharedAutomationTriggerOccurrence
export type AutomationRun = Omit<SharedAutomationRun, 'retryGeneration' | 'retryOfRunId'> &
  Readonly<{
    /** Generation zero is the scheduler-owned logical occurrence. */
    retryGeneration?: number
    /** Present only for a user-requested retry generation. */
    retryOfRunId?: string | null
  }>
export type AutomationEditorConfiguration = SharedAutomationEditorConfiguration
export type AutomationManualRetryReason = SharedAutomationManualRetryReason
export type AutomationRunWithEligibility = SharedAutomationRunWithEligibility

export type AutomationManagementAction =
  | 'automations.createDefinition'
  | 'automations.updateDefinition'
  | 'automations.setEnabled'
  | 'automations.deleteDefinition'
  | 'automations.retryRun'

export type AutomationEvent = Readonly<{
  id: string
  type: string
  occurredAt: number
  projectId?: string
  workspaceId?: string
}>

export type AutomationEventOccurrence = AutomationEvent &
  Readonly<{
    deliveryAttempts: number
    nextAttemptAt: number | null
    deliveredAt: number | null
    createdAt: number
  }>

export type AutomationStore = {
  transaction<T>(work: () => T): T
  insertDefinition(definition: AutomationDefinition): void
  updateDefinition(
    definition: AutomationDefinition,
    expectedUpdatedAt: number,
    beforeCommit?: () => void
  ): boolean
  deleteDefinition(id: string, expectedUpdatedAt: number, beforeCommit?: () => void): boolean
  getDefinition(id: string): AutomationDefinition | null
  countDefinitions(): number
  listDefinitions(enabledOnly?: boolean): AutomationDefinition[]
  listDefinitionsByIds(ids: readonly string[]): AutomationDefinition[]
  setDefinitionEnabled(
    id: string,
    expectedEnabled: boolean,
    expectedUpdatedAt: number,
    enabled: boolean,
    updatedAt: number,
    nextRunAt: number | null,
    beforeCommit?: () => void
  ): boolean
  updateNextRunAt(id: string, expected: number | null, next: number | null): boolean
  listDueSchedules(now: number, limit: number): AutomationDefinition[]
  getNextWakeAt(after?: number): number | null
  insertRun(run: AutomationRun): boolean
  getRun(id: string): AutomationRun | null
  getRunByIdempotencyKey(automationId: string, idempotencyKey: string): AutomationRun | null
  getLatestRunByIdempotencyKey(automationId: string, idempotencyKey: string): AutomationRun | null
  listRuns(input: {
    automationId?: string
    automationIds?: readonly string[]
    statuses?: readonly AutomationRunStatus[]
    order?: 'oldest' | 'recent'
    limit: number
  }): AutomationRun[]
  listRunnableAutomationIds(now: number, limit: number): string[]
  listRunnableRunsForAutomation(automationId: string, now: number, limit: number): AutomationRun[]
  countStartsSince(automationId: string, since: number): number
  countStartsSinceMany(
    requests: readonly { automationId: string; since: number }[]
  ): ReadonlyMap<string, number>
  listLatestRunsForIdempotencyKeys(
    keys: readonly { automationId: string; idempotencyKey: string }[]
  ): AutomationRun[]
  claimRun(id: string, expected: 'queued' | 'retry_wait', now: number, requestId: string): boolean
  finishRun(input: {
    id: string
    status: 'succeeded' | 'failed' | 'timed_out' | 'interrupted' | 'cancelled' | 'budget_exhausted'
    finishedAt: number
    resultCode: string
    result: Record<string, unknown> | null
    error: Record<string, unknown> | null
    auditId: string | null
  }): boolean
  scheduleRetry(input: {
    id: string
    expected: 'running' | 'interrupted'
    nextAttemptAt: number
    resultCode: string
    error: Record<string, unknown> | null
    auditId: string | null
  }): boolean
  deferRun(
    id: string,
    expected: 'queued' | 'retry_wait',
    nextAttemptAt: number,
    resultCode: string
  ): boolean
  cancelPending(automationId: string, now: number): number
  markRunningInterrupted(now: number): AutomationRun[]
  pruneTerminalRuns(finishedBefore: number, retainPerAutomation: number): void
  insertEventOccurrence(event: AutomationEvent, createdAt: number): boolean
  getEventOccurrence(id: string): AutomationEventOccurrence | null
  listPendingEventOccurrences(now: number, limit: number): AutomationEventOccurrence[]
  markEventDelivered(id: string, deliveredAt: number): boolean
  recordEventDeliveryFailure(id: string, attemptedAt: number, nextAttemptAt: number): boolean
  pruneDeliveredEventOccurrences(finishedBefore: number, retain: number): void
}

export type AutomationRegistry = {
  describe(id: string): ControlDescription | null
  validateInput(id: string, input: unknown, context: ControlContext): boolean
  invoke<T>(invocation: {
    id: string
    input: unknown
    context: AutomationInvocationContext
  }): Promise<ControlResult<T>>
}

export type AutomationInvocationContext = {
  principal: { type: 'automation'; id: string }
  consumer: 'automation'
  workspaceId: string | null
  projectId: string | null
  requestId: string
  trustedAutomation: NonNullable<
    import('../controlPlane/types').ControlContext['trustedAutomation']
  >
  automationRunId: string
  idempotencyKey: string
  deadlineAt: number
  signal: AbortSignal
}

export type AutomationAuditPort = {
  appendAttempt(input: {
    auditId: string
    requestId: string
    occurredAt: number
    definition: AutomationDefinition
    run: AutomationRun
    description: ControlDescription
    decision: 'allow' | 'deny'
    resultCode: string
    result: unknown
    error: unknown
  }): void | Promise<void>
  appendManagement(input: {
    auditId: string
    requestId: string
    occurredAt: number
    action: AutomationManagementAction
    definitionId: string
    principal: AutomationManagementContext['principal']
    consumer: AutomationManagementContext['consumer']
    scope: AutomationScope | null
    decision: 'allow' | 'deny'
    resultCode: string
    params: unknown
    receipts: readonly {
      effect: 'db.write'
      status: 'applied' | 'skipped' | 'failed'
      resourceId: string
    }[]
    correlation?: Readonly<Record<string, unknown>>
  }): void
}

export type AutomationManagementContext = Readonly<{
  requestId: string
  principal: Readonly<{
    type: 'renderer-user' | 'workspace-agent' | 'cli'
    id: string
  }>
  consumer: 'renderer-ipc' | 'command-socket' | 'mcp'
}>

export type AutomationTimeoutResult<T> =
  | Readonly<{ timedOut: false; value: T }>
  | Readonly<{ timedOut: true }>

export type AutomationClock = {
  now: () => number
  withTimeout: <T>(
    promise: Promise<T>,
    timeoutMs: number,
    controller: AbortController
  ) => Promise<AutomationTimeoutResult<T>>
}
