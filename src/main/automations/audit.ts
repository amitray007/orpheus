import type { DbLike } from '../db/types'
import { recursivelyRedact } from '../workspaceOrchestration/redaction'
import type { AutomationAuditPort } from './types'

const INSERT_AUTOMATION_AUDIT = `INSERT OR IGNORE INTO control_audit (
  audit_id, request_id, occurred_at, consumer, operation_id, operation_version,
  principal_kind, runtime_id, project_id, workspace_ids_json, permission, tier,
  decision, declared_effects_json, redacted_params_json, receipts_json,
  result_code, correlation_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
const SAFE_AUDIT_ID = /^[A-Za-z0-9._:-]{1,128}$/

function resultReceipts(result: unknown): unknown[] {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return []
  const effects = (result as Record<string, unknown>)['effects']
  return Array.isArray(effects) ? effects : []
}

function nestedAuditId(result: unknown): string | null {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return null
  const value = (result as Record<string, unknown>)['auditId']
  return typeof value === 'string' && SAFE_AUDIT_ID.test(value) ? value : null
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
      const redactedResult = recursivelyRedact({
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
        JSON.stringify(recursivelyRedact(resultReceipts(input.result))),
        input.resultCode,
        JSON.stringify({
          automationId: input.definition.id,
          runId: input.run.id,
          idempotencyKey: input.run.idempotencyKey,
          attempt: input.run.attempt,
          domainAuditId: nestedAuditId(input.result),
          outcome: redactedResult
        })
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
