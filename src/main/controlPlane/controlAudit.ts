import type { DbLike } from '../db/types'
import type {
  WorkspaceAuditPort,
  WorkspaceControlAuditRecord
} from '../workspaceOrchestration/types'

const INSERT_CONTROL_AUDIT = `INSERT OR IGNORE INTO control_audit (
  audit_id,
  request_id,
  occurred_at,
  consumer,
  operation_id,
  operation_version,
  principal_kind,
  runtime_id,
  project_id,
  workspace_ids_json,
  permission,
  tier,
  decision,
  declared_effects_json,
  redacted_params_json,
  receipts_json,
  result_code,
  correlation_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export function createControlAuditStore(db: DbLike): WorkspaceAuditPort {
  const insert = db.prepare(INSERT_CONTROL_AUDIT)
  return {
    append(record: WorkspaceControlAuditRecord): void {
      insert.run(
        record.auditId,
        record.requestId,
        record.occurredAt,
        record.consumer,
        record.operation.id,
        record.operation.version,
        record.principal.kind,
        record.principal.runtimeId,
        record.target.projectId,
        JSON.stringify(record.target.workspaceIds),
        record.permission,
        record.tier,
        record.decision,
        JSON.stringify(record.declaredEffects),
        JSON.stringify(record.redactedParams),
        JSON.stringify(record.receipts),
        record.result.code,
        JSON.stringify(record.correlation ?? {})
      )
    }
  }
}
