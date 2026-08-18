// ---------------------------------------------------------------------------
// footerActions.ts — Storage module for footer quick-action descriptors
//
// Three-scope additive list (global → project → workspace).
// No hide/override semantics in phase 3a.
//
// Merge semantics for listMerged(workspaceId):
//   [...global rows] ++ [...project rows] ++ [...workspace rows]
//   Within each scope ordered by `position` ASC.
//
// Harness capability gating (R8/U6, multi-harness migration): listMerged
// additionally filters the merged list through filterActionsForHarness
// against the workspace's resolved harness descriptor. This is a LIST-TIME
// concern only — it never mutates or deletes a stored row, so a user's
// existing footer_actions_* rows are always intact in the DB even when a
// particular action is momentarily hidden because the workspace's harness
// lacks the capability it needs (e.g. workspace.fork on a harness with
// capabilities.fork === false). Switching the workspace back to a harness
// that has the capability makes the same stored row visible again with no
// re-seed, no migration, and no data loss.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type {
  FooterActionDescriptor,
  FooterActionDraft,
  FooterActionScope,
  PromptDescriptor
} from '../shared/types'
import type { HarnessDescriptor } from '../shared/harness/types'
import { resolveHarness } from './harness/registry'

// ---------------------------------------------------------------------------
// Row shapes from SQLite
// ---------------------------------------------------------------------------

type GlobalRow = {
  id: string
  label: string
  icon: string | null
  action_id: string
  params_json: string
  visible_when: string
  position: number
  created_at: number
  updated_at: number
  prompts_json: string | null
}

type ProjectRow = GlobalRow & { project_id: string }
type WorkspaceRow = GlobalRow & { workspace_id: string }

// ---------------------------------------------------------------------------
// Row → descriptor mapping
// ---------------------------------------------------------------------------

function parseParams(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through to default
  }
  return {}
}

function parsePrompts(json: string | null): PromptDescriptor[] | undefined {
  if (!json) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed as PromptDescriptor[]
  } catch {
    // fall through
  }
  return undefined
}

function coerceVisibility(raw: string): FooterActionDescriptor['visibleWhen'] {
  if (raw === 'always' || raw === 'idle' || raw === 'awaitingInput') return raw
  return 'always'
}

function fromGlobalRow(row: GlobalRow): FooterActionDescriptor {
  const prompts = parsePrompts(row.prompts_json)
  return {
    id: row.id,
    scope: 'global',
    scopeId: null,
    label: row.label,
    icon: row.icon,
    actionId: row.action_id,
    params: parseParams(row.params_json),
    visibleWhen: coerceVisibility(row.visible_when),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(prompts ? { prompts } : {})
  }
}

function fromProjectRow(row: ProjectRow): FooterActionDescriptor {
  const prompts = parsePrompts(row.prompts_json)
  return {
    id: row.id,
    scope: 'project',
    scopeId: row.project_id,
    label: row.label,
    icon: row.icon,
    actionId: row.action_id,
    params: parseParams(row.params_json),
    visibleWhen: coerceVisibility(row.visible_when),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(prompts ? { prompts } : {})
  }
}

function fromWorkspaceRow(row: WorkspaceRow): FooterActionDescriptor {
  const prompts = parsePrompts(row.prompts_json)
  return {
    id: row.id,
    scope: 'workspace',
    scopeId: row.workspace_id,
    label: row.label,
    icon: row.icon,
    actionId: row.action_id,
    params: parseParams(row.params_json),
    visibleWhen: coerceVisibility(row.visible_when),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(prompts ? { prompts } : {})
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listGlobal(): FooterActionDescriptor[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM footer_actions_global ORDER BY position ASC')
    .all() as GlobalRow[]
  return rows.map(fromGlobalRow)
}

export function listForProject(projectId: string): FooterActionDescriptor[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM footer_actions_project WHERE project_id = ? ORDER BY position ASC')
    .all(projectId) as ProjectRow[]
  return rows.map(fromProjectRow)
}

export function listForWorkspace(workspaceId: string): FooterActionDescriptor[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM footer_actions_workspace WHERE workspace_id = ? ORDER BY position ASC')
    .all(workspaceId) as WorkspaceRow[]
  return rows.map(fromWorkspaceRow)
}

export function listMerged(workspaceId: string): FooterActionDescriptor[] {
  const db = getDb()
  const ws = db
    .prepare('SELECT project_id, harness_id FROM workspaces WHERE id = ?')
    .get(workspaceId) as { project_id: string; harness_id: string | null } | undefined

  const globals = listGlobal()
  const projectRows = ws ? listForProject(ws.project_id) : []
  const workspaceRows = listForWorkspace(workspaceId)

  const merged = [...globals, ...projectRows, ...workspaceRows]
  const harness = resolveHarness(ws?.harness_id)
  return filterActionsForHarness(merged, harness)
}

// ---------------------------------------------------------------------------
// Harness capability gating (R8/U6)
//
// DATA, not if/else: each action_id that needs a capability to make sense
// is a single entry in this table, mapping to a predicate over the
// workspace's resolved HarnessDescriptor. Adding a harness-gated action
// later is a one-line addition here, never a new branch in listMerged.
//
// An action_id that is NOT a key in this table is always allowed — this is
// deliberate, not an oversight, and is what keeps every user-authored row
// working regardless of which action_id they used. Two consequences worth
// being explicit about:
//
//   1. terminal.sendInput is intentionally NOT gated here. Its action_id is
//      generic (any text can be sent to any terminal), but a specific
//      PAYLOAD like Claude's `/copy`/`/context`/`/clear` is not — those are
//      Claude Code slash commands and are meaningless as literal text on a
//      harness that doesn't understand them. Telling apart "Claude's own
//      seeded /copy row" from "a user's hand-written sendInput row" would
//      need a stored provenance marker, and footer_actions_* has no such
//      column — adding one is a schema/data-migration decision this unit is
//      explicitly scoped to avoid (see the module header and registry.ts's
//      data-only-removal discipline for the same "additive, never
//      destructive" principle applied elsewhere). So sendInput rows are
//      left alone unconditionally: the safe failure mode is an inert
//      slash-command chip on a foreign harness, never a silently deleted
//      user row. A future unit that adds real per-row harness provenance
//      (e.g. seeding stamps a `harnessId` onto rows it creates) can extend
//      this table with a sendInput entry that checks that marker without
//      touching any row that predates it.
//   2. workspace.archive/workspace.rename and any other harness-agnostic
//      action_id also fall through unfiltered by design — they need no
//      capability from any harness.
// ---------------------------------------------------------------------------

type ActionGate = (harness: HarnessDescriptor) => boolean

const FOOTER_ACTION_GATES: Record<string, ActionGate> = {
  'workspace.fork': (h) => h.capabilities.fork,
  'session.getUsage': (h) => h.capabilities.usage,
  'session.getCost': (h) => h.capabilities.usage,
  'footer.modelSelect': (h) => h.curated?.model !== undefined,
  'footer.effortSelect': (h) => h.curated?.effort !== undefined
}

/**
 * Filters a list of footer actions (any mix of scopes) down to the ones
 * that make sense for `harness`. Pure — no DB access, no mutation of the
 * input array or its elements — so it can be exercised directly against
 * fixtures without needing a real SQLite DB or Electron. Never drops an
 * action whose action_id isn't in FOOTER_ACTION_GATES; see that table's
 * own header comment for why (chiefly: preserving every user-authored row,
 * including hand-written terminal.sendInput rows, untouched).
 */
export function filterActionsForHarness(
  actions: FooterActionDescriptor[],
  harness: HarnessDescriptor
): FooterActionDescriptor[] {
  return actions.filter((action) => {
    const gate = FOOTER_ACTION_GATES[action.actionId]
    return gate ? gate(harness) : true
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function create(
  scope: FooterActionScope,
  scopeId: string | null,
  draft: FooterActionDraft
): FooterActionDescriptor {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const paramsJson = JSON.stringify(draft.params ?? {})

  const promptsJson = draft.prompts ? JSON.stringify(draft.prompts) : null

  if (scope === 'global') {
    const maxRow = db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM footer_actions_global')
      .get() as { m: number }
    const position = draft.position ?? maxRow.m + 1
    db.prepare(
      `
      INSERT INTO footer_actions_global
        (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      draft.label,
      draft.icon ?? null,
      draft.actionId,
      paramsJson,
      draft.visibleWhen,
      position,
      now,
      now,
      promptsJson
    )
    return fromGlobalRow(
      db.prepare('SELECT * FROM footer_actions_global WHERE id = ?').get(id) as GlobalRow
    )
  }

  if (scope === 'project') {
    if (!scopeId) throw new Error('scopeId required for project-scope footer action')
    const maxRow = db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) AS m FROM footer_actions_project WHERE project_id = ?'
      )
      .get(scopeId) as { m: number }
    const position = draft.position ?? maxRow.m + 1
    db.prepare(
      `
      INSERT INTO footer_actions_project
        (id, project_id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      scopeId,
      draft.label,
      draft.icon ?? null,
      draft.actionId,
      paramsJson,
      draft.visibleWhen,
      position,
      now,
      now,
      promptsJson
    )
    return fromProjectRow(
      db.prepare('SELECT * FROM footer_actions_project WHERE id = ?').get(id) as ProjectRow
    )
  }

  // scope === 'workspace'
  if (!scopeId) throw new Error('scopeId required for workspace-scope footer action')
  const maxRow = db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) AS m FROM footer_actions_workspace WHERE workspace_id = ?'
    )
    .get(scopeId) as { m: number }
  const position = draft.position ?? maxRow.m + 1
  db.prepare(
    `
    INSERT INTO footer_actions_workspace
      (id, workspace_id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    scopeId,
    draft.label,
    draft.icon ?? null,
    draft.actionId,
    paramsJson,
    draft.visibleWhen,
    position,
    now,
    now,
    promptsJson
  )
  return fromWorkspaceRow(
    db.prepare('SELECT * FROM footer_actions_workspace WHERE id = ?').get(id) as WorkspaceRow
  )
}

export function update(id: string, patch: Partial<FooterActionDraft>): FooterActionDescriptor {
  const db = getDb()
  const now = Date.now()

  // Locate the row across all three tables
  const globalRow = db.prepare('SELECT * FROM footer_actions_global WHERE id = ?').get(id) as
    | GlobalRow
    | undefined
  if (globalRow) {
    const merged = applyPatch(globalRow, patch, now)
    db.prepare(
      `
      UPDATE footer_actions_global
      SET label = ?, icon = ?, action_id = ?, params_json = ?, visible_when = ?,
          position = ?, updated_at = ?, prompts_json = ?
      WHERE id = ?
    `
    ).run(
      merged.label,
      merged.icon,
      merged.action_id,
      merged.params_json,
      merged.visible_when,
      merged.position,
      merged.updated_at,
      merged.prompts_json,
      id
    )
    return fromGlobalRow(
      db.prepare('SELECT * FROM footer_actions_global WHERE id = ?').get(id) as GlobalRow
    )
  }

  const projectRow = db.prepare('SELECT * FROM footer_actions_project WHERE id = ?').get(id) as
    | ProjectRow
    | undefined
  if (projectRow) {
    const merged = applyPatch(projectRow, patch, now)
    db.prepare(
      `
      UPDATE footer_actions_project
      SET label = ?, icon = ?, action_id = ?, params_json = ?, visible_when = ?,
          position = ?, updated_at = ?, prompts_json = ?
      WHERE id = ?
    `
    ).run(
      merged.label,
      merged.icon,
      merged.action_id,
      merged.params_json,
      merged.visible_when,
      merged.position,
      merged.updated_at,
      merged.prompts_json,
      id
    )
    return fromProjectRow(
      db.prepare('SELECT * FROM footer_actions_project WHERE id = ?').get(id) as ProjectRow
    )
  }

  const workspaceRow = db.prepare('SELECT * FROM footer_actions_workspace WHERE id = ?').get(id) as
    | WorkspaceRow
    | undefined
  if (workspaceRow) {
    const merged = applyPatch(workspaceRow, patch, now)
    db.prepare(
      `
      UPDATE footer_actions_workspace
      SET label = ?, icon = ?, action_id = ?, params_json = ?, visible_when = ?,
          position = ?, updated_at = ?, prompts_json = ?
      WHERE id = ?
    `
    ).run(
      merged.label,
      merged.icon,
      merged.action_id,
      merged.params_json,
      merged.visible_when,
      merged.position,
      merged.updated_at,
      merged.prompts_json,
      id
    )
    return fromWorkspaceRow(
      db.prepare('SELECT * FROM footer_actions_workspace WHERE id = ?').get(id) as WorkspaceRow
    )
  }

  throw new Error(`Footer action not found: ${id}`)
}

function applyPatch(row: GlobalRow, patch: Partial<FooterActionDraft>, now: number): GlobalRow {
  return {
    ...row,
    label: patch.label ?? row.label,
    icon: 'icon' in patch ? (patch.icon ?? null) : row.icon,
    action_id: patch.actionId ?? row.action_id,
    params_json: patch.params !== undefined ? JSON.stringify(patch.params) : row.params_json,
    visible_when: patch.visibleWhen ?? row.visible_when,
    position: patch.position ?? row.position,
    updated_at: now,
    prompts_json:
      'prompts' in patch
        ? patch.prompts !== undefined
          ? JSON.stringify(patch.prompts)
          : null
        : row.prompts_json
  }
}

export function remove(id: string): void {
  const db = getDb()
  // Try all three tables — exactly one will match (or none if already gone)
  db.prepare('DELETE FROM footer_actions_global WHERE id = ?').run(id)
  db.prepare('DELETE FROM footer_actions_project WHERE id = ?').run(id)
  db.prepare('DELETE FROM footer_actions_workspace WHERE id = ?').run(id)
}

export function reorder(
  scope: FooterActionScope,
  scopeId: string | null,
  orderedIds: string[]
): void {
  const db = getDb()
  const table =
    scope === 'global'
      ? 'footer_actions_global'
      : scope === 'project'
        ? 'footer_actions_project'
        : 'footer_actions_workspace'

  const update = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`)
  const reorderTx = db.transaction(() => {
    orderedIds.forEach((id, idx) => {
      update.run(idx, id)
    })
  })
  void scopeId // not needed for the UPDATE (id is unique across all rows in a table)
  reorderTx()
}

// ---------------------------------------------------------------------------
// First-install seed
// Inserts the default global footer actions when the table is empty.
// Idempotent: skips entirely if any row already exists.
// ---------------------------------------------------------------------------

const ACTION_TERMINAL_SEND_INPUT = 'terminal.sendInput'

const DEFAULT_SEEDS: Array<{
  label: string
  icon: string | null
  actionId: string
  params: Record<string, unknown>
  visibleWhen: FooterActionDescriptor['visibleWhen']
  prompts?: PromptDescriptor[]
}> = [
  {
    label: 'Fork',
    icon: 'GitFork',
    actionId: 'workspace.fork',
    params: {},
    visibleWhen: 'always'
  },
  {
    label: '/copy',
    icon: 'Clipboard',
    actionId: ACTION_TERMINAL_SEND_INPUT,
    params: { text: '/copy', submit: true },
    visibleWhen: 'idle'
  },
  {
    label: '/context',
    icon: 'Brain',
    actionId: ACTION_TERMINAL_SEND_INPUT,
    params: { text: '/context', submit: true },
    visibleWhen: 'always'
  },
  {
    label: '/clear',
    icon: 'Eraser',
    actionId: ACTION_TERMINAL_SEND_INPUT,
    params: { text: '/clear', submit: true },
    visibleWhen: 'idle'
  },
  {
    label: '/compact',
    icon: 'ArrowsInLineHorizontal',
    actionId: ACTION_TERMINAL_SEND_INPUT,
    params: { text: '/compact', submit: true },
    visibleWhen: 'idle'
  },
  {
    label: '/cost',
    icon: 'CurrencyDollar',
    actionId: ACTION_TERMINAL_SEND_INPUT,
    params: { text: '/cost', submit: true },
    visibleWhen: 'always'
  },
  {
    label: 'Model',
    icon: 'Robot',
    actionId: 'footer.modelSelect',
    params: {},
    visibleWhen: 'always'
  },
  {
    label: 'Effort',
    icon: 'Sliders',
    actionId: 'footer.effortSelect',
    params: {},
    visibleWhen: 'always'
  },
  {
    label: 'Archive',
    icon: 'Archive',
    actionId: 'workspace.archive',
    params: {},
    visibleWhen: 'idle'
  },
  {
    label: 'Rename',
    icon: 'PencilSimple',
    actionId: 'workspace.rename',
    params: {},
    visibleWhen: 'idle',
    prompts: [
      {
        key: 'name',
        label: 'New name',
        placeholder: 'Workspace name',
        default: '{workspaceName}'
      }
    ]
  },
  {
    label: 'Context',
    icon: 'Gauge',
    actionId: 'session.getUsage',
    params: {},
    visibleWhen: 'always'
  }
]

export function seedDefaultFooterActions(): void {
  const db = getDb()
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM footer_actions_global').get() as { c: number }
  ).c

  if (count > 0) return // already seeded or user has customised

  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const seedTx = db.transaction(() => {
    DEFAULT_SEEDS.forEach((seed, idx) => {
      insert.run(
        randomUUID(),
        seed.label,
        seed.icon,
        seed.actionId,
        JSON.stringify(seed.params),
        seed.visibleWhen,
        idx,
        now,
        now,
        seed.prompts ? JSON.stringify(seed.prompts) : null
      )
    })
  })
  seedTx()

  console.log('[footerActions] seeded', DEFAULT_SEEDS.length, 'default global footer actions')
}

// ---------------------------------------------------------------------------
// Reset to defaults: delete all global rows then re-seed.
// ---------------------------------------------------------------------------

export function resetToDefaults(): void {
  const db = getDb()
  db.prepare('DELETE FROM footer_actions_global').run()
  seedDefaultFooterActions()
  console.log('[footerActions] reset to defaults complete')
}
