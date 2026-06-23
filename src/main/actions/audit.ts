// ---------------------------------------------------------------------------
// actions/audit.ts — Audit log for Quick Actions mutators
//
// Ring buffer: keeps the last 500 entries per workspace.
// Params are SECRET_KEYS-redacted before storage.
// ---------------------------------------------------------------------------

import { getDb } from '../db'
import type { ActionAuditEntry } from '../../shared/types'

// ---------------------------------------------------------------------------
// SECRET_KEYS deny-list — mirrors the pattern used in terminal:mount.
// Any param key matching these (case-insensitive) has its value replaced with
// "[REDACTED]" before JSON.stringify.
// ---------------------------------------------------------------------------
const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'credential',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
  'anthropic_api_key'
])

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase())
}

/**
 * Redact secret values from a params object and JSON.stringify the result.
 * Top-level keys are checked; nested objects are not recursed (sufficient for
 * the flat param shapes used by all current actions).
 */
export function redactAndSerialize(params: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    redacted[k] = isSecretKey(k) ? '[REDACTED]' : v
  }
  return JSON.stringify(redacted)
}

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

type AuditRow = {
  id: number
  workspace_id: string
  action_id: string
  params_json: string
  result_code: string
  consumer_hint: string
  created_at: number
}

function rowToEntry(row: AuditRow): ActionAuditEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actionId: row.action_id,
    paramsJson: row.params_json,
    resultCode: row.result_code,
    consumerHint: row.consumer_hint,
    createdAt: row.created_at
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function recordAudit(entry: Omit<ActionAuditEntry, 'id'>): void {
  const db = getDb()

  db.prepare(
    `INSERT INTO action_audit_log
       (workspace_id, action_id, params_json, result_code, consumer_hint, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    entry.workspaceId,
    entry.actionId,
    entry.paramsJson,
    entry.resultCode,
    entry.consumerHint,
    entry.createdAt
  )

  // Prune oldest beyond 500 per workspace — ring-buffer semantics.
  // ORDER BY created_at DESC is covered by idx_action_audit_workspace_created
  // (workspace_id, created_at DESC); id DESC would force a temp B-tree sort.
  db.prepare(
    `DELETE FROM action_audit_log
     WHERE workspace_id = ?
       AND id NOT IN (
         SELECT id FROM action_audit_log
         WHERE workspace_id = ?
         ORDER BY created_at DESC
         LIMIT 500
       )`
  ).run(entry.workspaceId, entry.workspaceId)
}

export function getAuditHistory(workspaceId: string, limit: number = 50): ActionAuditEntry[] {
  const db = getDb()
  // ORDER BY created_at DESC uses the (workspace_id, created_at DESC) covering index.
  const rows = db
    .prepare(
      `SELECT * FROM action_audit_log
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(workspaceId, limit) as AuditRow[]
  return rows.map(rowToEntry)
}
