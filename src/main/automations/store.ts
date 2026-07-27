import type { DbLike } from '../db/types'
import type {
  AutomationDefinition,
  AutomationEventOccurrence,
  AutomationRun,
  AutomationRunStatus,
  AutomationStore
} from './types'

type DefinitionRow = {
  id: string
  name: string
  trigger_kind: 'schedule' | 'event'
  trigger_json: string
  operation_id: string
  operation_version: 1
  params_json: string
  scope_kind: 'app' | 'project' | 'workspace'
  project_id: string | null
  workspace_id: string | null
  enabled: number
  idempotency_mode: 'none' | 'keyed' | 'natural'
  timeout_ms: number
  concurrency_limit: number
  retry_max_attempts: number
  retry_base_delay_ms: number
  retry_max_delay_ms: number
  run_max_elapsed_ms: number
  rolling_window_ms: number
  rolling_max_starts: number
  next_run_at: number | null
  created_at: number
  updated_at: number
}

type RunRow = {
  id: string
  automation_id: string
  trigger_kind: 'schedule' | 'event'
  trigger_key: string
  trigger_occurred_at: number
  idempotency_key: string
  status: AutomationRunStatus
  attempt: number
  queued_at: number
  started_at: number | null
  finished_at: number | null
  next_attempt_at: number | null
  result_code: string | null
  result_json: string | null
  error_json: string | null
  request_id: string | null
  audit_id: string | null
}

type EventOccurrenceRow = {
  id: string
  event_type: string
  occurred_at: number
  project_id: string | null
  workspace_id: string | null
  delivery_attempts: number
  next_attempt_at: number | null
  delivered_at: number | null
  created_at: number
}

const DEFINITION_COLUMNS = `id, name, trigger_kind, trigger_json, operation_id,
  operation_version, params_json, scope_kind, project_id, workspace_id, enabled,
  idempotency_mode, timeout_ms, concurrency_limit, retry_max_attempts,
  retry_base_delay_ms, retry_max_delay_ms, run_max_elapsed_ms, rolling_window_ms,
  rolling_max_starts, next_run_at, created_at, updated_at`

const RUN_COLUMNS = `id, automation_id, trigger_kind, trigger_key,
  trigger_occurred_at, idempotency_key, status, attempt, queued_at, started_at,
  finished_at, next_attempt_at, result_code, result_json, error_json, request_id,
  audit_id`
const EVENT_OCCURRENCE_COLUMNS = `id, event_type, occurred_at, project_id,
  workspace_id, delivery_attempts, next_attempt_at, delivered_at, created_at`

const INVALID_JSON = Symbol('invalid-json')

function parseJson(value: string | null): unknown {
  if (value == null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return INVALID_JSON
  }
}

function definitionFromRow(row: DefinitionRow): AutomationDefinition | null {
  const trigger = parseJson(row.trigger_json)
  const params = parseJson(row.params_json)
  if (
    trigger === INVALID_JSON ||
    params === INVALID_JSON ||
    trigger == null ||
    typeof trigger !== 'object' ||
    Array.isArray(trigger) ||
    !['schedule', 'event'].includes(String((trigger as Record<string, unknown>)['kind']))
  ) {
    return null
  }
  const scope: AutomationDefinition['scope'] =
    row.scope_kind === 'app'
      ? { kind: 'app' }
      : row.scope_kind === 'project'
        ? { kind: 'project', projectId: row.project_id ?? '' }
        : {
            kind: 'workspace',
            projectId: row.project_id ?? '',
            workspaceId: row.workspace_id ?? ''
          }
  return {
    id: row.id,
    name: row.name,
    trigger: trigger as AutomationDefinition['trigger'],
    operationId: row.operation_id,
    operationVersion: row.operation_version,
    params,
    scope,
    enabled: row.enabled === 1,
    idempotency: row.idempotency_mode,
    timeoutMs: row.timeout_ms,
    concurrencyLimit: row.concurrency_limit,
    retry: {
      maxAttempts: row.retry_max_attempts,
      baseDelayMs: row.retry_base_delay_ms,
      maxDelayMs: row.retry_max_delay_ms,
      maxElapsedMs: row.run_max_elapsed_ms
    },
    rollingBudget: {
      windowMs: row.rolling_window_ms,
      maxStarts: row.rolling_max_starts
    },
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function recordJson(value: string | null): Record<string, unknown> | null {
  const parsed = parseJson(value)
  return parsed !== INVALID_JSON &&
    parsed != null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function runFromRow(row: RunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    trigger: {
      kind: row.trigger_kind,
      key: row.trigger_key,
      occurredAt: row.trigger_occurred_at
    },
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempt: row.attempt,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nextAttemptAt: row.next_attempt_at,
    resultCode: row.result_code,
    result: recordJson(row.result_json),
    error: recordJson(row.error_json),
    requestId: row.request_id,
    auditId: row.audit_id
  }
}

function eventOccurrenceFromRow(row: EventOccurrenceRow): AutomationEventOccurrence {
  return {
    id: row.id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    ...(row.project_id == null ? {} : { projectId: row.project_id }),
    ...(row.workspace_id == null ? {} : { workspaceId: row.workspace_id }),
    deliveryAttempts: row.delivery_attempts,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at
  }
}

function scopeColumns(scope: AutomationDefinition['scope']): [string | null, string | null] {
  if (scope.kind === 'app') return [null, null]
  if (scope.kind === 'project') return [scope.projectId, null]
  return [scope.projectId, scope.workspaceId]
}

export function createAutomationStore(db: DbLike): AutomationStore {
  const insertDefinition = db.prepare(`INSERT INTO automation_definitions (
    ${DEFINITION_COLUMNS}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertRun = db.prepare(`INSERT OR IGNORE INTO automation_runs (
    ${RUN_COLUMNS}
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertEventOccurrence = db.prepare(`INSERT OR IGNORE INTO automation_event_occurrences (
    id, event_type, occurred_at, project_id, workspace_id, delivery_attempts,
    next_attempt_at, delivered_at, created_at
  ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?)`)

  return {
    transaction<T>(work: () => T): T {
      db.exec('BEGIN IMMEDIATE')
      try {
        const value = work()
        db.exec('COMMIT')
        return value
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Preserve the transaction or audit failure that triggered rollback.
        }
        throw error
      }
    },
    insertDefinition(definition) {
      const [projectId, workspaceId] = scopeColumns(definition.scope)
      insertDefinition.run(
        definition.id,
        definition.name,
        definition.trigger.kind,
        JSON.stringify(definition.trigger),
        definition.operationId,
        definition.operationVersion,
        JSON.stringify(definition.params),
        definition.scope.kind,
        projectId,
        workspaceId,
        definition.enabled ? 1 : 0,
        definition.idempotency,
        definition.timeoutMs,
        definition.concurrencyLimit,
        definition.retry.maxAttempts,
        definition.retry.baseDelayMs,
        definition.retry.maxDelayMs,
        definition.retry.maxElapsedMs,
        definition.rollingBudget.windowMs,
        definition.rollingBudget.maxStarts,
        definition.nextRunAt,
        definition.createdAt,
        definition.updatedAt
      )
    },
    deleteDefinition(id) {
      db.prepare('DELETE FROM automation_definitions WHERE id = ?').run(id)
      const changed = db.prepare('SELECT changes() AS count').get() as { count: number } | undefined
      return changed?.count === 1
    },
    getDefinition(id) {
      const row = db
        .prepare(`SELECT ${DEFINITION_COLUMNS} FROM automation_definitions WHERE id = ?`)
        .get(id) as DefinitionRow | undefined
      return row == null ? null : definitionFromRow(row)
    },
    listDefinitions(enabledOnly = false) {
      const sql = `SELECT ${DEFINITION_COLUMNS} FROM automation_definitions${
        enabledOnly ? ' WHERE enabled = 1' : ''
      } ORDER BY created_at ASC, id ASC`
      return (db.prepare(sql).all() as DefinitionRow[]).flatMap((row) => {
        const definition = definitionFromRow(row)
        return definition == null ? [] : [definition]
      })
    },
    setDefinitionEnabled(
      id,
      expectedEnabled,
      expectedUpdatedAt,
      enabled,
      updatedAt,
      nextRunAt,
      beforeCommit
    ) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(
          `UPDATE automation_definitions
           SET enabled = ?, updated_at = ?, next_run_at = ?
           WHERE id = ? AND enabled = ? AND updated_at = ?`
        ).run(enabled ? 1 : 0, updatedAt, nextRunAt, id, expectedEnabled ? 1 : 0, expectedUpdatedAt)
        const changed = db.prepare('SELECT changes() AS count').get() as
          | { count: number }
          | undefined
        if (changed?.count !== 1) {
          db.exec('ROLLBACK')
          return false
        }
        if (!enabled) {
          db.prepare(
            `UPDATE automation_runs
             SET status = 'cancelled', finished_at = ?, next_attempt_at = NULL,
                 result_code = 'cancelled', error_json = NULL
             WHERE automation_id = ? AND status IN ('queued', 'retry_wait')`
          ).run(updatedAt, id)
        }
        beforeCommit?.()
        db.exec('COMMIT')
        return true
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Preserve the original transaction failure.
        }
        throw error
      }
    },
    updateNextRunAt(id, expected, next) {
      const where = expected == null ? 'next_run_at IS NULL' : 'next_run_at = ?'
      const params = expected == null ? [next, id] : [next, id, expected]
      db.prepare(`UPDATE automation_definitions SET next_run_at = ? WHERE id = ? AND ${where}`).run(
        ...params
      )
      const row = db
        .prepare('SELECT next_run_at FROM automation_definitions WHERE id = ?')
        .get(id) as { next_run_at: number | null } | undefined
      return row?.next_run_at === next
    },
    listDueSchedules(now, limit) {
      return (
        db
          .prepare(
            `SELECT ${DEFINITION_COLUMNS} FROM automation_definitions
             WHERE enabled = 1 AND trigger_kind = 'schedule'
               AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at ASC, id ASC LIMIT ?`
          )
          .all(now, limit) as DefinitionRow[]
      ).flatMap((row) => {
        const definition = definitionFromRow(row)
        return definition == null ? [] : [definition]
      })
    },
    insertRun(run) {
      insertRun.run(
        run.id,
        run.automationId,
        run.trigger.kind,
        run.trigger.key,
        run.trigger.occurredAt,
        run.idempotencyKey,
        run.status,
        run.attempt,
        run.queuedAt,
        run.startedAt,
        run.finishedAt,
        run.nextAttemptAt,
        run.resultCode,
        run.result == null ? null : JSON.stringify(run.result),
        run.error == null ? null : JSON.stringify(run.error),
        run.requestId,
        run.auditId
      )
      const persisted = db
        .prepare('SELECT id FROM automation_runs WHERE automation_id = ? AND idempotency_key = ?')
        .get(run.automationId, run.idempotencyKey) as { id: string } | undefined
      return persisted?.id === run.id
    },
    getRun(id) {
      const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM automation_runs WHERE id = ?`).get(id) as
        | RunRow
        | undefined
      return row == null ? null : runFromRow(row)
    },
    getRunByIdempotencyKey(automationId, idempotencyKey) {
      const row = db
        .prepare(
          `SELECT ${RUN_COLUMNS} FROM automation_runs
           WHERE automation_id = ? AND idempotency_key = ?`
        )
        .get(automationId, idempotencyKey) as RunRow | undefined
      return row == null ? null : runFromRow(row)
    },
    listRuns(input) {
      const conditions: string[] = []
      const params: unknown[] = []
      if (input.automationId != null) {
        conditions.push('automation_id = ?')
        params.push(input.automationId)
      }
      if (input.statuses != null && input.statuses.length > 0) {
        conditions.push(`status IN (${input.statuses.map(() => '?').join(', ')})`)
        params.push(...input.statuses)
      }
      const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`
      const order =
        input.order === 'recent' ? 'queued_at DESC, rowid DESC' : 'queued_at ASC, rowid ASC'
      params.push(input.limit)
      return (
        db
          .prepare(
            `SELECT ${RUN_COLUMNS} FROM automation_runs${where}
             ORDER BY ${order} LIMIT ?`
          )
          .all(...params) as RunRow[]
      ).map(runFromRow)
    },
    countStartsSince(automationId, since) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM automation_runs
           WHERE automation_id = ? AND started_at IS NOT NULL AND started_at >= ?`
        )
        .get(automationId, since) as { count: number }
      return row.count
    },
    claimRun(id, expected, now, requestId) {
      db.prepare(
        `UPDATE automation_runs
         SET status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, ?),
             next_attempt_at = NULL, request_id = ?
         WHERE id = ? AND status = ?`
      ).run(now, requestId, id, expected)
      const row = db
        .prepare('SELECT status, request_id FROM automation_runs WHERE id = ?')
        .get(id) as { status: AutomationRunStatus; request_id: string | null } | undefined
      return row?.status === 'running' && row.request_id === requestId
    },
    finishRun(input) {
      db.prepare(
        `UPDATE automation_runs
         SET status = ?, finished_at = ?, next_attempt_at = NULL,
             result_code = ?, result_json = ?, error_json = ?, audit_id = ?
         WHERE id = ? AND status = 'running'`
      ).run(
        input.status,
        input.finishedAt,
        input.resultCode,
        input.result == null ? null : JSON.stringify(input.result),
        input.error == null ? null : JSON.stringify(input.error),
        input.auditId,
        input.id
      )
      const row = db.prepare('SELECT status FROM automation_runs WHERE id = ?').get(input.id) as
        | { status: AutomationRunStatus }
        | undefined
      return row?.status === input.status
    },
    scheduleRetry(input) {
      db.prepare(
        `UPDATE automation_runs
         SET status = 'retry_wait', next_attempt_at = ?, finished_at = NULL,
             result_code = ?, error_json = ?, audit_id = ?
         WHERE id = ? AND status = ?`
      ).run(
        input.nextAttemptAt,
        input.resultCode,
        input.error == null ? null : JSON.stringify(input.error),
        input.auditId,
        input.id,
        input.expected
      )
      const row = db
        .prepare('SELECT status, next_attempt_at FROM automation_runs WHERE id = ?')
        .get(input.id) as
        | { status: AutomationRunStatus; next_attempt_at: number | null }
        | undefined
      return row?.status === 'retry_wait' && row.next_attempt_at === input.nextAttemptAt
    },
    deferRun(id, expected, nextAttemptAt, resultCode) {
      db.prepare(
        `UPDATE automation_runs SET status = 'retry_wait', next_attempt_at = ?,
         result_code = ? WHERE id = ? AND status = ?`
      ).run(nextAttemptAt, resultCode, id, expected)
      const row = db
        .prepare('SELECT status, next_attempt_at FROM automation_runs WHERE id = ?')
        .get(id) as { status: AutomationRunStatus; next_attempt_at: number | null } | undefined
      return row?.status === 'retry_wait' && row.next_attempt_at === nextAttemptAt
    },
    cancelPending(automationId, now) {
      const before = db
        .prepare(
          `SELECT COUNT(*) AS count FROM automation_runs
           WHERE automation_id = ? AND status IN ('queued', 'retry_wait')`
        )
        .get(automationId) as { count: number }
      db.prepare(
        `UPDATE automation_runs SET status = 'cancelled', finished_at = ?,
         next_attempt_at = NULL, result_code = 'disabled'
         WHERE automation_id = ? AND status IN ('queued', 'retry_wait')`
      ).run(now, automationId)
      return before.count
    },
    markRunningInterrupted(now) {
      const rows = (
        db
          .prepare(`SELECT ${RUN_COLUMNS} FROM automation_runs WHERE status = 'running'`)
          .all() as RunRow[]
      ).map(runFromRow)
      db.prepare(
        `UPDATE automation_runs SET status = 'interrupted', finished_at = ?,
         result_code = 'interrupted' WHERE status = 'running'`
      ).run(now)
      return rows.map((run) => ({ ...run, status: 'interrupted', finishedAt: now }))
    },
    pruneTerminalRuns(finishedBefore, retainPerAutomation) {
      db.prepare(
        `DELETE FROM automation_runs
         WHERE status IN (
           'succeeded', 'failed', 'timed_out', 'interrupted', 'cancelled', 'budget_exhausted'
         )
         AND (
           finished_at < ?
           OR id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY automation_id
                 ORDER BY finished_at DESC, queued_at DESC, id DESC
               ) AS retained_rank
               FROM automation_runs
               WHERE status IN (
                 'succeeded', 'failed', 'timed_out', 'interrupted', 'cancelled',
                 'budget_exhausted'
               )
             )
             WHERE retained_rank > ?
           )
         )`
      ).run(finishedBefore, retainPerAutomation)
    },
    insertEventOccurrence(event, createdAt) {
      insertEventOccurrence.run(
        event.id,
        event.type,
        event.occurredAt,
        event.projectId ?? null,
        event.workspaceId ?? null,
        createdAt
      )
      const changed = db.prepare('SELECT changes() AS count').get() as { count: number } | undefined
      return changed?.count === 1
    },
    getEventOccurrence(id) {
      const row = db
        .prepare(
          `SELECT ${EVENT_OCCURRENCE_COLUMNS}
           FROM automation_event_occurrences WHERE id = ?`
        )
        .get(id) as EventOccurrenceRow | undefined
      return row == null ? null : eventOccurrenceFromRow(row)
    },
    listPendingEventOccurrences(now, limit) {
      return (
        db
          .prepare(
            `SELECT ${EVENT_OCCURRENCE_COLUMNS}
             FROM automation_event_occurrences
             WHERE delivered_at IS NULL
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY occurred_at ASC, id ASC
             LIMIT ?`
          )
          .all(now, limit) as EventOccurrenceRow[]
      ).map(eventOccurrenceFromRow)
    },
    markEventDelivered(id, deliveredAt) {
      db.prepare(
        `UPDATE automation_event_occurrences
         SET delivered_at = ?, next_attempt_at = NULL
         WHERE id = ? AND delivered_at IS NULL`
      ).run(deliveredAt, id)
      const row = db
        .prepare('SELECT delivered_at FROM automation_event_occurrences WHERE id = ?')
        .get(id) as { delivered_at: number | null } | undefined
      return row?.delivered_at === deliveredAt
    },
    recordEventDeliveryFailure(id, attemptedAt, nextAttemptAt) {
      db.prepare(
        `UPDATE automation_event_occurrences
         SET delivery_attempts = delivery_attempts + 1, next_attempt_at = ?
         WHERE id = ? AND delivered_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`
      ).run(nextAttemptAt, id, attemptedAt)
      const row = db
        .prepare(
          `SELECT delivered_at, next_attempt_at
           FROM automation_event_occurrences WHERE id = ?`
        )
        .get(id) as { delivered_at: number | null; next_attempt_at: number | null } | undefined
      return row !== undefined && row.delivered_at == null && row.next_attempt_at === nextAttemptAt
    },
    pruneDeliveredEventOccurrences(finishedBefore, retain) {
      db.prepare(
        `DELETE FROM automation_event_occurrences
         WHERE delivered_at IS NOT NULL
           AND (
             delivered_at < ?
             OR id IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (
                   ORDER BY delivered_at DESC, occurred_at DESC, id DESC
                 ) AS retained_rank
                 FROM automation_event_occurrences
                 WHERE delivered_at IS NOT NULL
               )
               WHERE retained_rank > ?
             )
           )`
      ).run(finishedBefore, retain)
    }
  }
}
