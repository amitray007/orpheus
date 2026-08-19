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
import { resolveHarness, HARNESSES } from './harness/registry'
import { CLAUDE_DEFAULT_ACTIONS } from './harness/claude/actions'
import { isActionTypeApplicable } from '../shared/harness/actionTypeGating'

// ---------------------------------------------------------------------------
// Row shapes from SQLite
// ---------------------------------------------------------------------------

// Fields shared by all three footer_actions_* tables.
type BaseRow = {
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

// C5: harness_id exists ONLY on footer_actions_global (see schema.ts's own
// column comment) — NULL for every row that predates this column and for
// every user-authored row. footer_actions_project/_workspace have NO such
// column at all (project/workspace-scope rows are always user/prompt-
// authored, never harness-seeded), so ProjectRow/WorkspaceRow below
// deliberately extend BaseRow, not GlobalRow, and never carry this field.
type GlobalRow = BaseRow & { harness_id: string | null }
type ProjectRow = BaseRow & { project_id: string }
type WorkspaceRow = BaseRow & { workspace_id: string }

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
    // C5: threaded through even when NULL — filterActionsForHarness's
    // terminal.sendInput gate reads this field directly (undefined/null
    // both mean "applies everywhere", see that gate's own comment).
    harnessId: row.harness_id,
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
// Harness capability gating (R8/U6, extended by C5)
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
//   1. terminal.sendInput is now gated (C5), but ONLY via `action.harnessId`
//      — never via the predicate signature every other gate uses. A
//      Claude-seeded `/copy`/`/context`/`/clear`/`/compact`/`/cost` row is
//      meaningless as literal text on a harness that doesn't understand it,
//      but a user's HAND-WRITTEN sendInput row (harnessId: null/undefined,
//      because create() never sets it) must never be filtered — the load-
//      bearing safety property this whole unit exists to protect. See
//      sendInputPassesHarnessGate below for the actual rule: absent
//      provenance always passes; stamped provenance passes only for the
//      matching, currently-resolved harness.
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

const ACTION_TERMINAL_SEND_INPUT = 'terminal.sendInput'

/**
 * C5's provenance gate for terminal.sendInput rows — separate from
 * FOOTER_ACTION_GATES because it depends on the ROW (its stamped
 * harnessId), not just the target harness, unlike every capability gate
 * above. NULL/undefined harnessId (a user-authored row, or any row seeded
 * before this column existed) ALWAYS passes — this is the one rule
 * protecting existing data, and is asserted directly by
 * scripts/verify-footer-actions.ts's mutation tests. A stamped harnessId
 * passes only when it matches the WORKSPACE's resolved harness id, so a
 * Claude-seeded `/copy` row is hidden on a Codex workspace but still shows
 * on every Claude workspace, exactly like before this column existed.
 */
function sendInputPassesHarnessGate(
  action: FooterActionDescriptor,
  harness: HarnessDescriptor
): boolean {
  const provenance = action.harnessId
  if (provenance === null || provenance === undefined) return true
  return provenance === harness.id
}

/**
 * Filters a list of footer actions (any mix of scopes) down to the ones
 * that make sense for `harness`. Pure — no DB access, no mutation of the
 * input array or its elements — so it can be exercised directly against
 * fixtures without needing a real SQLite DB or Electron. Never drops an
 * action whose action_id isn't in FOOTER_ACTION_GATES (and, for
 * terminal.sendInput, whose harnessId is null/undefined) — see the header
 * comment above for why (chiefly: preserving every user-authored row,
 * including hand-written terminal.sendInput rows, untouched).
 */
export function filterActionsForHarness(
  actions: FooterActionDescriptor[],
  harness: HarnessDescriptor
): FooterActionDescriptor[] {
  return actions.filter((action) => {
    if (action.actionId === ACTION_TERMINAL_SEND_INPUT) {
      return sendInputPassesHarnessGate(action, harness)
    }
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
    // C5: a user-created row (this function, called from the Settings UI's
    // "Add action" flow) never carries a draft.harnessId — every caller of
    // create() predates that field. NULL here is correct AND load-bearing:
    // it is exactly what makes a hand-written row immune to
    // sendInputPassesHarnessGate above. Only seedDefaultFooterActionsForHarness
    // (below) ever passes a real harness id, via its own direct INSERT.
    db.prepare(
      `
      INSERT INTO footer_actions_global
        (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json, harness_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      promptsJson,
      draft.harnessId ?? null
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

function applyPatch<T extends BaseRow>(row: T, patch: Partial<FooterActionDraft>, now: number): T {
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
// First-install seed (C5, support-multi-harness: per-harness)
//
// DRIFT RESOLUTION: this module used to carry its OWN hardcoded 11-row
// DEFAULT_SEEDS list, independent of (and already diverged from) Claude's
// descriptor.defaultActions in harness/claude/actions.ts, which nothing
// read. That duplication is gone — CLAUDE_DEFAULT_ACTIONS is now the single
// canonical list (see that file's own header for the full drift-resolution
// story, including a real-production-data correction of an initial
// dev-DB-informed guess, and for why it, not this module, owns Claude's
// defaults), and this module seeds generically from `descriptor.defaultActions`
// for whichever harness needs it.
//
// TWO SEED PATHS, deliberately kept separate:
//
//   1. seedDefaultFooterActions() — the ORIGINAL first-install seeder,
//      UNCHANGED in observable behavior: still a single bulk `count === 0`
//      check against the whole table, still inserts Claude's rows (now
//      sourced from CLAUDE_DEFAULT_ACTIONS instead of a parallel literal),
//      still a total no-op the instant footer_actions_global has ANY row.
//      This is the byte-identical guarantee for every existing install:
//      someone who already has their seeded (or since-customised) rows —
//      whatever shape or count they are, including a subset a user
//      deliberately pruned down to (see scripts/verify-footer-actions.ts's
//      real-user-shaped fixture, modeled on an actual production DB
//      inspected read-only during this unit's review) — keeps seeing
//      exactly those, untouched, forever; this function cannot run again
//      for them. The ONE new behavior: rows it inserts on
//      a genuinely fresh install are now stamped harness_id = 'claude',
//      whereas a pre-C5 install's rows stay NULL (this function never
//      retroactively stamps an existing row — see the schema column's own
//      comment for why NULL must never be backfilled after the fact).
//
//   2. seedDefaultFooterActionsForHarness(harnessId) — the NEW, additive
//      per-harness seeder. For a NON-Claude harness, checks the count of
//      rows stamped for THAT specific harness_id (not the whole table), so
//      it correctly seeds a second harness's defaults even on an install
//      that already has Claude's (or a user's customised) rows sitting in
//      the table. For CLAUDE specifically it ALSO respects the whole-table
//      check (see this function's own doc comment for why: a pre-C5
//      install's rows are NULL-provenance, not 'claude'-stamped, so the
//      per-harness check alone would seed CLAUDE_DEFAULT_ACTIONS.length more
//      Claude rows on top of an existing user's rows — whatever shape those
//      already are, including a deliberately-pruned subset — a real bug
//      this special case exists to prevent). Called once per known harness
//      at boot (see index.ts's boot
//      sequence) — a harness with defaultActions already seeded is a
//      no-op; a harness with no defaultActions declared is also a no-op
//      (nothing to seed). Never touches, reorders, or deletes any row
//      belonging to a DIFFERENT harness_id (including NULL) — strictly
//      additive INSERTs, appended after the current max position.
// ---------------------------------------------------------------------------

const DEFAULT_SEEDS: Array<{
  label: string
  icon: string | null
  actionId: string
  params: Record<string, unknown>
  visibleWhen: FooterActionDescriptor['visibleWhen']
  prompts?: PromptDescriptor[]
}> = CLAUDE_DEFAULT_ACTIONS.map((draft) => ({
  label: draft.label,
  icon: draft.icon ?? null,
  actionId: draft.actionId,
  params: draft.params,
  visibleWhen: draft.visibleWhen,
  ...(draft.prompts ? { prompts: draft.prompts } : {})
}))

export function seedDefaultFooterActions(): void {
  const db = getDb()
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM footer_actions_global').get() as { c: number }
  ).c

  if (count > 0) return // already seeded or user has customised

  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json, harness_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        seed.prompts ? JSON.stringify(seed.prompts) : null,
        'claude'
      )
    })
  })
  seedTx()

  console.log('[footerActions] seeded', DEFAULT_SEEDS.length, 'default global footer actions')
}

/**
 * C5's additive per-harness seeder. Seeds `harnessId`'s
 * descriptor.defaultActions into footer_actions_global, stamped with that
 * harness id, ONLY when zero rows are currently stamped for it — checked
 * via `WHERE harness_id = ?`, never the whole-table count
 * seedDefaultFooterActions() above uses. This is what lets a SECOND
 * harness's defaults get seeded on an install that already has Claude's (or
 * a user's customised) rows: the whole-table count is non-zero, but no row
 * yet carries this harness's id.
 *
 * CLAUDE IS SPECIAL-CASED to ALSO respect the whole-table check
 * seedDefaultFooterActions() uses (not just its own per-harness-id check).
 * Reason: every pre-C5 install's 11 Claude rows are NULL-provenance (they
 * predate this column — see the schema column's own comment), so the
 * per-harness `WHERE harness_id = 'claude'` count for such an install is
 * ZERO even though the table is full of Claude's own rows. Without this
 * special case, this function would "correctly" see no claude-stamped rows
 * and seed 11 MORE on top of an existing user's 11 — a real duplication
 * bug, caught by scripts/verify-footer-actions.ts's assertion 4 (an
 * existing user's row count must be unchanged; this is exactly what
 * exercising it against a real pre-C5-shaped fixture surfaced during
 * development). Claude was always "the whole-table harness" before this
 * column existed, so its seeding boundary must stay the whole-table check;
 * a GENUINELY new harness (never seeded before this column existed, so its
 * absence from the table is real, not a stale/un-stamped artifact) is the
 * only case where the narrower per-harness-id check is correct.
 *
 * Never touches an existing row of any provenance (matching or not) —
 * INSERT only, appended after the current global max position, exactly
 * like create()'s own append behavior. A harness with no `defaultActions`
 * declared, or whose `defaultActions` is an empty array, is a correct
 * no-op: seeding nothing is not an error.
 */
export function seedDefaultFooterActionsForHarness(harnessId: string): void {
  const descriptor = resolveHarness(harnessId)
  const defaults = descriptor.defaultActions
  if (!defaults || defaults.length === 0) return

  const db = getDb()

  if (descriptor.id === 'claude') {
    // See this function's own header comment: Claude's seeding boundary is
    // the WHOLE TABLE, matching seedDefaultFooterActions()'s own gate,
    // because a pre-C5 install's 11 rows are NULL-provenance, not
    // 'claude'-stamped, and must never be seeded over.
    const wholeTableCount = (
      db.prepare('SELECT COUNT(*) AS c FROM footer_actions_global').get() as { c: number }
    ).c
    if (wholeTableCount > 0) return
  }

  const existing = (
    db
      .prepare('SELECT COUNT(*) AS c FROM footer_actions_global WHERE harness_id = ?')
      .get(descriptor.id) as { c: number }
  ).c
  if (existing > 0) return // this harness already has its seeded rows

  const now = Date.now()
  const maxRow = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM footer_actions_global')
    .get() as { m: number }
  const insert = db.prepare(`
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json, harness_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const seedTx = db.transaction(() => {
    defaults.forEach((draft, idx) => {
      insert.run(
        randomUUID(),
        draft.label,
        draft.icon ?? null,
        draft.actionId,
        JSON.stringify(draft.params ?? {}),
        draft.visibleWhen,
        maxRow.m + 1 + idx,
        now,
        now,
        draft.prompts ? JSON.stringify(draft.prompts) : null,
        descriptor.id
      )
    })
  })
  seedTx()

  console.log(
    '[footerActions] seeded',
    defaults.length,
    `default global footer actions for harness '${descriptor.id}'`
  )
}

/**
 * Seeds every KNOWN harness's defaults (see seedDefaultFooterActionsForHarness's
 * own idempotency contract) — the boot-time entry point index.ts calls
 * alongside seedDefaultFooterActions(), so a build that registers a second
 * harness later seeds it automatically without a data-migration step. Order
 * follows HARNESSES' own declaration order; harmless to re-run every boot.
 */
export function seedDefaultFooterActionsForAllHarnesses(): void {
  for (const descriptor of HARNESSES) {
    seedDefaultFooterActionsForHarness(descriptor.id)
  }
}

// ---------------------------------------------------------------------------
// Reset to defaults: delete all global rows then re-seed.
// ---------------------------------------------------------------------------

export function resetToDefaults(): void {
  const db = getDb()
  db.prepare('DELETE FROM footer_actions_global').run()
  seedDefaultFooterActions()
  // C5: re-seed every OTHER known harness's defaults too — the DELETE above
  // wiped a non-Claude harness's seeded rows same as Claude's, and without
  // this they would silently vanish from "Reset to defaults" instead of
  // coming back. seedDefaultFooterActions() only ever seeds Claude
  // (matching its pre-C5 behavior exactly), so this is what actually
  // restores a second harness's rows.
  seedDefaultFooterActionsForAllHarnesses()
  console.log('[footerActions] reset to defaults complete')
}
