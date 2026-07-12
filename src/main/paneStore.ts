// ---------------------------------------------------------------------------
// src/main/paneStore.ts
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U4,
// KTD2). REPLACES the flat-row Panes store (U12/1ccc4f5): persistence for
// the three-level hierarchy — `pane_panels` -> `pane_layouts` ->
// `pane_terminals` (src/main/db/schema.ts) — independent of claude
// workspaces entirely.
//
//   Panel   (General | Project)   — a sidebar row.
//     └─ Layout (unlimited)       — a saved split-tree arrangement bound to
//                                   a folder.
//          └─ Terminal (≤4/layout, ≤12/panel — enforced by the renderer's
//                                   split-tree ops + caller checks, not here)
//
// CRUD mirrors src/main/reviewStore.ts's shape: plain better-sqlite3
// prepared statements against getDb(), row <-> record mapping functions, no
// ORM. `split_tree_json` round-trips through JSON.parse/stringify at the
// store boundary so callers work with the typed `SplitTree` shape, never
// raw JSON text.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { PanePanel, PanePanelKind, PaneLayout, PaneTerminal, SplitTree } from '../shared/types'

// ---------------------------------------------------------------------------
// Row shapes from SQLite
// ---------------------------------------------------------------------------

type PanePanelRow = {
  id: string
  kind: string
  name: string
  dir: string | null
  position: number
  created_at: number
  updated_at: number
  expanded_in_sidebar: number
}

type PaneLayoutRow = {
  id: string
  panel_id: string
  name: string
  dir: string
  split_tree_json: string
  position: number
  created_at: number
  updated_at: number
}

type PaneTerminalRow = {
  id: string
  layout_id: string
  command: string
  name: string
  position: number
  created_at: number
  updated_at: number
}

function coerceKind(raw: string): PanePanelKind {
  return raw === 'project' ? 'project' : 'general'
}

function panelFromRow(row: PanePanelRow): PanePanel {
  return {
    id: row.id,
    kind: coerceKind(row.kind),
    name: row.name,
    dir: row.dir,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Mirrors projects.ts's `expandedInSidebar: row.expanded_in_sidebar === 1`.
    expandedInSidebar: row.expanded_in_sidebar === 1
  }
}

/** `split_tree_json` is `'null'` for a freshly-created layout with no panes
 *  yet — JSON.parse of that literal correctly yields `null`. Any malformed
 *  JSON (should never happen — this store is the only writer) also falls
 *  back to null rather than throwing, so a corrupt row can't crash the
 *  whole panel/layout list. */
function parseSplitTree(json: string): SplitTree | null {
  try {
    return JSON.parse(json) as SplitTree | null
  } catch {
    return null
  }
}

function layoutFromRow(row: PaneLayoutRow): PaneLayout {
  return {
    id: row.id,
    panelId: row.panel_id,
    name: row.name,
    dir: row.dir,
    splitTree: parseSplitTree(row.split_tree_json),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function terminalFromRow(row: PaneTerminalRow): PaneTerminal {
  return {
    id: row.id,
    layoutId: row.layout_id,
    command: row.command,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** Idempotent: seeds the single 'general' panel if one doesn't already
 *  exist. The 'pane-general-panel-seed' data step (src/main/db/data-steps.ts)
 *  already does this once at boot for every DB (fresh or upgraded) — this is
 *  a defensive second call site (mirrors the plan's "a data-step OR an
 *  idempotent ensure-on-first-list" guidance) so `listPanels()` never returns
 *  an empty list even if the data step were ever skipped. */
function ensureGeneralPanel(): void {
  const db = getDb()
  const existing = db.prepare("SELECT 1 FROM pane_panels WHERE kind = 'general'").get()
  if (existing) return
  const now = Date.now()
  db.prepare(
    `INSERT INTO pane_panels (id, kind, name, dir, position, created_at, updated_at)
     VALUES (?, 'general', 'General', NULL, 0, ?, ?)`
  ).run(randomUUID(), now, now)
}

export function listPanels(): PanePanel[] {
  ensureGeneralPanel()
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM pane_panels ORDER BY position ASC, created_at ASC')
    .all() as PanePanelRow[]
  return rows.map(panelFromRow)
}

export interface CreatePanelInput {
  kind: PanePanelKind
  name: string
  /** Panes-only folder path — never written to the `projects` table (KTD8). */
  dir?: string | null
  position?: number
}

export function createPanel(input: CreatePanelInput): PanePanel {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const dir = input.dir ?? null
  const position =
    input.position ??
    ((
      db.prepare('SELECT MAX(position) AS maxPos FROM pane_panels').get() as {
        maxPos: number | null
      }
    ).maxPos ?? -1) + 1

  db.prepare(
    `INSERT INTO pane_panels (id, kind, name, dir, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.kind, input.name, dir, position, now, now)

  return panelFromRow(db.prepare('SELECT * FROM pane_panels WHERE id = ?').get(id) as PanePanelRow)
}

export interface UpdatePanelInput {
  name?: string
  dir?: string | null
  position?: number
}

export function updatePanel(id: string, patch: UpdatePanelInput): PanePanel {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM pane_panels WHERE id = ?').get(id) as
    | PanePanelRow
    | undefined
  if (!existing) throw new Error(`Pane panel not found: ${id}`)

  const now = Date.now()
  const name = patch.name ?? existing.name
  const dir = patch.dir !== undefined ? patch.dir : existing.dir
  const position = patch.position ?? existing.position

  db.prepare(
    'UPDATE pane_panels SET name = ?, dir = ?, position = ?, updated_at = ? WHERE id = ?'
  ).run(name, dir, position, now, id)

  return panelFromRow(db.prepare('SELECT * FROM pane_panels WHERE id = ?').get(id) as PanePanelRow)
}

export function deletePanel(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM pane_panels WHERE id = ?').run(id)
}

/** Persists sidebar expand/collapse state for a panel row. Mirrors
 *  projects.ts's setProjectExpandedInSidebar exactly — a one-column UPDATE,
 *  no read-back (the renderer already holds the optimistic local value). */
export function setPanelExpanded(id: string, expanded: boolean): void {
  const db = getDb()
  db.prepare('UPDATE pane_panels SET expanded_in_sidebar = ? WHERE id = ?').run(
    expanded ? 1 : 0,
    id
  )
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

export function listLayouts(panelId: string): PaneLayout[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM pane_layouts WHERE panel_id = ? ORDER BY position ASC, created_at ASC')
    .all(panelId) as PaneLayoutRow[]
  return rows.map(layoutFromRow)
}

/** Single-row lookup by id — mirrors listLayouts' row->record mapping but for
 *  exactly one layout. Added for Fix #23: the `pane:mount` IPC handler
 *  (src/main/index.ts) receives a `workspaceId` param that, for panes, is
 *  actually the LAYOUT id (see that handler's comment) — it needs to resolve
 *  the layout's own `dir` to find the correct cwd to launch the pane's setup
 *  command in, and `getWorkspace(layoutId)` can't do that (a layout is not a
 *  workspace row). Returns null (not throw) when no row matches, so callers
 *  can fall back cleanly — same contract as a typical single-row "maybe"
 *  lookup, unlike updateLayout's throw-on-missing (that path already assumes
 *  the caller resolved a real id before mutating it). */
export function getLayout(id: string): PaneLayout | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM pane_layouts WHERE id = ?').get(id) as
    | PaneLayoutRow
    | undefined
  return row ? layoutFromRow(row) : null
}

export interface CreateLayoutInput {
  panelId: string
  name: string
  dir: string
  position?: number
}

export function createLayout(input: CreateLayoutInput): PaneLayout {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const position =
    input.position ??
    ((
      db
        .prepare('SELECT MAX(position) AS maxPos FROM pane_layouts WHERE panel_id = ?')
        .get(input.panelId) as { maxPos: number | null }
    ).maxPos ?? -1) + 1

  db.prepare(
    `INSERT INTO pane_layouts (id, panel_id, name, dir, split_tree_json, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'null', ?, ?, ?)`
  ).run(id, input.panelId, input.name, input.dir, position, now, now)

  return layoutFromRow(
    db.prepare('SELECT * FROM pane_layouts WHERE id = ?').get(id) as PaneLayoutRow
  )
}

export interface UpdateLayoutInput {
  name?: string
  dir?: string
  splitTree?: SplitTree | null
  position?: number
}

export function updateLayout(id: string, patch: UpdateLayoutInput): PaneLayout {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM pane_layouts WHERE id = ?').get(id) as
    | PaneLayoutRow
    | undefined
  if (!existing) throw new Error(`Pane layout not found: ${id}`)

  const now = Date.now()
  const name = patch.name ?? existing.name
  const dir = patch.dir ?? existing.dir
  const splitTreeJson =
    patch.splitTree !== undefined ? JSON.stringify(patch.splitTree) : existing.split_tree_json
  const position = patch.position ?? existing.position

  db.prepare(
    'UPDATE pane_layouts SET name = ?, dir = ?, split_tree_json = ?, position = ?, updated_at = ? WHERE id = ?'
  ).run(name, dir, splitTreeJson, position, now, id)

  return layoutFromRow(
    db.prepare('SELECT * FROM pane_layouts WHERE id = ?').get(id) as PaneLayoutRow
  )
}

export function deleteLayout(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM pane_layouts WHERE id = ?').run(id)
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

export function listTerminals(layoutId: string): PaneTerminal[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT * FROM pane_terminals WHERE layout_id = ? ORDER BY position ASC, created_at ASC'
    )
    .all(layoutId) as PaneTerminalRow[]
  return rows.map(terminalFromRow)
}

export interface CreateTerminalInput {
  layoutId: string
  /** The setup rule — '' means a plain shell. */
  command: string
  /** Display name (issue #21) — '' (the default when omitted) falls back to
   *  "Pane N" by position in the renderer, so callers that don't care about
   *  naming yet (e.g. any pre-existing call site) keep working unchanged. */
  name?: string
  position: number
}

export function createTerminal(input: CreateTerminalInput): PaneTerminal {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const name = input.name ?? ''

  db.prepare(
    `INSERT INTO pane_terminals (id, layout_id, command, name, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.layoutId, input.command, name, input.position, now, now)

  return terminalFromRow(
    db.prepare('SELECT * FROM pane_terminals WHERE id = ?').get(id) as PaneTerminalRow
  )
}

export interface UpdateTerminalInput {
  command?: string
  /** Renaming (issue #21) — independent of `command`; setting this alone
   *  must never touch the setup rule or relaunch the pane's surface. */
  name?: string
  position?: number
}

export function updateTerminal(id: string, patch: UpdateTerminalInput): PaneTerminal {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM pane_terminals WHERE id = ?').get(id) as
    | PaneTerminalRow
    | undefined
  if (!existing) throw new Error(`Pane terminal not found: ${id}`)

  const now = Date.now()
  const command = patch.command ?? existing.command
  const name = patch.name ?? existing.name
  const position = patch.position ?? existing.position

  db.prepare(
    'UPDATE pane_terminals SET command = ?, name = ?, position = ?, updated_at = ? WHERE id = ?'
  ).run(command, name, position, now, id)

  return terminalFromRow(
    db.prepare('SELECT * FROM pane_terminals WHERE id = ?').get(id) as PaneTerminalRow
  )
}

export function deleteTerminal(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM pane_terminals WHERE id = ?').run(id)
}
