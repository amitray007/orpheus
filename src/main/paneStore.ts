// ---------------------------------------------------------------------------
// src/main/paneStore.ts
//
// Workbench Panes tab (U12) — persistence for the N declared terminal panes
// tiled within a claude workspace. A pane is metadata only: `{command,
// title, position, sizeFraction}`. Reopening the workspace re-runs each
// pane's command fresh in a new native surface (see the `pane:mount` IPC
// handler in src/main/index.ts) — no output/scrollback is persisted here,
// only the declaration needed to rebuild the tile layout.
//
// CRUD mirrors src/main/reviewStore.ts's shape: plain better-sqlite3
// prepared statements against getDb(), row <-> Pane mapping functions, no
// ORM.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { Pane } from '../shared/types'

// ---------------------------------------------------------------------------
// Row shape from SQLite
// ---------------------------------------------------------------------------

type PaneRow = {
  id: string
  workspace_id: string
  command: string
  title: string | null
  position: number
  size_fraction: number
  created_at: number
  updated_at: number
}

function fromRow(row: PaneRow): Pane {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    command: row.command,
    title: row.title,
    position: row.position,
    sizeFraction: row.size_fraction,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listByWorkspace(workspaceId: string): Pane[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM panes WHERE workspace_id = ? ORDER BY position ASC, created_at ASC')
    .all(workspaceId) as PaneRow[]
  return rows.map(fromRow)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface AddPaneInput {
  workspaceId: string
  command: string
  title?: string | null
  position: number
  sizeFraction?: number
}

export function add(input: AddPaneInput): Pane {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const title = input.title ?? null
  const sizeFraction = input.sizeFraction ?? 0

  db.prepare(
    `
    INSERT INTO panes
      (id, workspace_id, command, title, position, size_fraction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(id, input.workspaceId, input.command, title, input.position, sizeFraction, now, now)

  return fromRow(db.prepare('SELECT * FROM panes WHERE id = ?').get(id) as PaneRow)
}

export interface UpdatePaneInput {
  command?: string
  title?: string | null
  position?: number
  sizeFraction?: number
}

export function update(id: string, patch: UpdatePaneInput): Pane {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM panes WHERE id = ?').get(id) as PaneRow | undefined
  if (!existing) throw new Error(`Pane not found: ${id}`)

  const now = Date.now()
  const command = patch.command ?? existing.command
  const title = patch.title !== undefined ? patch.title : existing.title
  const position = patch.position ?? existing.position
  const sizeFraction = patch.sizeFraction ?? existing.size_fraction

  db.prepare(
    'UPDATE panes SET command = ?, title = ?, position = ?, size_fraction = ?, updated_at = ? WHERE id = ?'
  ).run(command, title, position, sizeFraction, now, id)

  return fromRow(db.prepare('SELECT * FROM panes WHERE id = ?').get(id) as PaneRow)
}

export function remove(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM panes WHERE id = ?').run(id)
}
