import type { DbLike } from '../db/types'
import { recursivelyRedact } from '../workspaceOrchestration/redaction'
import { persistableAutomationValue } from './resultPersistence'
import { AUTOMATION_LIMITS, type AutomationAuditPort } from './types'

const INSERT_AUTOMATION_AUDIT = `INSERT OR IGNORE INTO control_audit (
  audit_id, request_id, occurred_at, consumer, operation_id, operation_version,
  principal_kind, runtime_id, project_id, workspace_ids_json, permission, tier,
  decision, declared_effects_json, redacted_params_json, receipts_json,
  result_code, correlation_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
const SAFE_AUDIT_ID = /^[A-Za-z0-9._:-]{1,128}$/
const TRUNCATED_RECEIPTS: readonly unknown[] = Object.freeze([
  Object.freeze({
    effect: 'automation.result.receipts',
    status: 'skipped',
    message: 'Result receipts exceeded audit persistence safety limits.'
  })
])

function safelyIsArray(value: unknown): boolean {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

function ownDataProperty(result: unknown, key: string): unknown {
  if (result == null || typeof result !== 'object' || safelyIsArray(result)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, key)
    return descriptor != null && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function resultReceipts(result: unknown): unknown[] {
  const effects = ownDataProperty(result, 'effects')
  return safelyIsArray(effects) ? (effects as unknown[]) : []
}

function nestedAuditId(result: unknown): string | null {
  const value = ownDataProperty(result, 'auditId')
  return typeof value === 'string' && SAFE_AUDIT_ID.test(value) ? value : null
}

function boundedResultReceipts(result: unknown): readonly unknown[] {
  const bounded = persistableAutomationValue(resultReceipts(result))
  return safelyIsArray(bounded) ? (bounded as unknown[]) : TRUNCATED_RECEIPTS
}

function boundedAttemptCorrelation(input: {
  automationId: string
  runId: string
  idempotencyKey: string
  attempt: number
  domainAuditId: string | null
  result: unknown
  error: unknown
}): string {
  const base = {
    automationId: input.automationId,
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    attempt: input.attempt,
    domainAuditId: input.domainAuditId,
    outcome: null as unknown
  }
  const empty = JSON.stringify(base)
  const outcomeBudget =
    AUTOMATION_LIMITS.maxPersistedResultBytes - Buffer.byteLength(empty, 'utf8') + 4
  base.outcome = persistableAutomationValue(
    { result: input.result, error: input.error },
    outcomeBudget
  )
  const serialized = JSON.stringify(base)
  if (Buffer.byteLength(serialized, 'utf8') > AUTOMATION_LIMITS.maxPersistedResultBytes) {
    throw new Error('Bounded automation audit correlation exceeded its byte limit.')
  }
  return serialized
}

export function createAutomationAuditStore(db: DbLike): AutomationAuditPort {
  const insert = db.prepare(INSERT_AUTOMATION_AUDIT)
  const insertManagement = db.prepare(INSERT_AUTOMATION_AUDIT.replace('INSERT OR IGNORE', 'INSERT'))
  return {
    appendAttempt(input) {
      const projectId =
        input.definition.scope.kind === 'app' ? null : input.definition.scope.projectId
      const workspaceIds =
        input.definition.scope.kind === 'workspace' ? [input.definition.scope.workspaceId] : []
      const correlation = boundedAttemptCorrelation({
        automationId: input.definition.id,
        runId: input.run.id,
        idempotencyKey: input.run.idempotencyKey,
        attempt: input.run.attempt,
        domainAuditId: nestedAuditId(input.result),
        result: input.result,
        error: input.error
      })
      insert.run(
        input.auditId,
        input.requestId,
        input.occurredAt,
        'automation',
        input.definition.operationId,
        input.definition.operationVersion,
        'automation',
        null,
        projectId,
        JSON.stringify(workspaceIds),
        input.description.permission,
        input.description.risk.tier,
        input.decision,
        JSON.stringify(input.description.declaredEffects ?? []),
        JSON.stringify(recursivelyRedact(input.definition.params)),
        JSON.stringify(boundedResultReceipts(input.result)),
        input.resultCode,
        correlation
      )
    },
    appendManagement(input) {
      const projectId = input.scope?.kind === 'app' ? null : (input.scope?.projectId ?? null)
      const workspaceIds = input.scope?.kind === 'workspace' ? [input.scope.workspaceId] : []
      const consumer =
        input.consumer === 'renderer-ipc'
          ? 'renderer'
          : input.consumer === 'command-socket'
            ? 'cli'
            : 'mcp'
      insertManagement.run(
        input.auditId,
        input.requestId,
        input.occurredAt,
        consumer,
        input.action,
        1,
        input.principal.type,
        input.principal.type === 'workspace-agent' ? input.principal.id : null,
        projectId,
        JSON.stringify(workspaceIds),
        'automations.manage',
        2,
        input.decision,
        JSON.stringify(['db.write']),
        JSON.stringify(recursivelyRedact(input.params)),
        JSON.stringify(input.receipts),
        input.resultCode,
        JSON.stringify({
          requestId: input.requestId,
          definitionId: input.definitionId,
          principalId: input.principal.id,
          principalType: input.principal.type,
          ...input.correlation
        })
      )
    }
  }
}
