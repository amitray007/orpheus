import type {
  AutomationScopeBinding,
  ControlDescription,
  ControlResult
} from '../controlPlane/types'

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
  maxEventFanout: 200,
  maxRetainedRunsPerAutomation: 1_000,
  runRetentionMs: 30 * 24 * 60 * 60 * 1_000
})

export type AutomationTrigger =
  | Readonly<{ kind: 'schedule'; intervalMs: number; startAt?: number }>
  | Readonly<{ kind: 'event'; eventType: string }>

export type AutomationScope = AutomationScopeBinding
export type AutomationIdempotency = 'none' | 'keyed' | 'natural'

export type AutomationRetryBudget = Readonly<{
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  maxElapsedMs: number
}>

export type AutomationRollingBudget = Readonly<{
  windowMs: number
  maxStarts: number
}>

export type AutomationDefinitionDraft = Readonly<{
  name: string
  trigger: AutomationTrigger
  operationId: string
  params: unknown
  scope: AutomationScope
  enabled?: boolean
  idempotency: AutomationIdempotency
  timeoutMs: number
  concurrencyLimit: number
  retry: AutomationRetryBudget
  rollingBudget: AutomationRollingBudget
}>

export type AutomationDefinition = AutomationDefinitionDraft &
  Readonly<{
    id: string
    operationVersion: 1
    enabled: boolean
    nextRunAt: number | null
    createdAt: number
    updatedAt: number
  }>

export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'interrupted'
  | 'cancelled'
  | 'budget_exhausted'

export type AutomationTriggerOccurrence = Readonly<{
  kind: 'schedule' | 'event'
  key: string
  occurredAt: number
}>

export type AutomationRun = Readonly<{
  id: string
  automationId: string
  trigger: AutomationTriggerOccurrence
  idempotencyKey: string
  status: AutomationRunStatus
  attempt: number
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  nextAttemptAt: number | null
  resultCode: string | null
  result: Record<string, unknown> | null
  error: Record<string, unknown> | null
  requestId: string | null
  auditId: string | null
}>

export type AutomationEvent = Readonly<{
  id: string
  type: string
  occurredAt: number
  projectId?: string
  workspaceId?: string
}>

export type AutomationStore = {
  transaction<T>(work: () => T): T
  insertDefinition(definition: AutomationDefinition): void
  getDefinition(id: string): AutomationDefinition | null
  listDefinitions(enabledOnly?: boolean): AutomationDefinition[]
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
  insertRun(run: AutomationRun): boolean
  getRun(id: string): AutomationRun | null
  getRunByIdempotencyKey(automationId: string, idempotencyKey: string): AutomationRun | null
  listRuns(input: {
    automationId?: string
    statuses?: readonly AutomationRunStatus[]
    limit: number
  }): AutomationRun[]
  countStartsSince(automationId: string, since: number): number
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
}

export type AutomationRegistry = {
  describe(id: string): ControlDescription | null
  validateInput(id: string, input: unknown, context: AutomationInvocationContext): boolean
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
    action: 'automations.createDefinition' | 'automations.setEnabled'
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
    type: 'renderer-user' | 'cli'
    id: string
  }>
  consumer: 'renderer-ipc' | 'command-socket'
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
