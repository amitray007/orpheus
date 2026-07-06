// ---------------------------------------------------------------------------
// src/main/reviewStore.ts
//
// Workbench Git tab — Phase 4d: the LOCAL (Orpheus-owned) review-comment
// store — Epic G2's vision-critical differentiator. Local line-anchored
// comments live in the SAME inline diff display as GitHub's own review
// comments (Phase 4a/4b/4c), completing the 3-source comment model:
// github-from-others / my-github (both GhReviewCommentThread, via
// src/main/github.ts) / LOCAL (this module).
//
// THE AGENT-READABLE FOUNDATION (Epic G2's "agents can read the review
// store"): these comments live in plain SQLite (`review_comments` table,
// src/main/db/schema.ts) at ~/Library/Application Support/Orpheus/
// orpheus.sqlite — any process with DB access (an agent, a script, `sqlite3`
// on the CLI) can already read them directly:
//
//   sqlite3 ~/Library/"Application Support"/Orpheus/orpheus.sqlite \
//     "SELECT * FROM review_comments WHERE workspace_id = '<id>'"
//
// That's the durable, storage-level agent-integration point. On top of it,
// src/main/commandServer.ts's `reviews.list` dispatch action (see its own
// comment) surfaces the same data over the existing `orpheus` CLI/HTTP
// command channel, so an agent doesn't need direct DB access at all — just
// `orpheus cmd reviews.list --workspaceId <id>` (or the equivalent HTTP
// POST /cmd body). A future `reviews.add`/`reviews.resolve` write action is
// the natural next step (not added here — this phase's mandate is read
// access + the store itself, see the module's own task notes) and would
// slot into the SAME dispatch table alongside this one.
//
// CRUD mirrors src/main/footerActions.ts's shape: plain better-sqlite3
// prepared statements against getDb(), row <-> LocalReviewComment mapping
// functions, no ORM. Kept as its own module (not folded into github.ts,
// which is GitHub-`gh`-CLI-specific) since this store has nothing to do with
// GitHub at all — it's pure local SQLite.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import type { GhReviewCommentSide, LocalReviewComment } from '../shared/types'

// ---------------------------------------------------------------------------
// Row shape from SQLite
// ---------------------------------------------------------------------------

type ReviewCommentRow = {
  id: string
  workspace_id: string
  pr_number: number | null
  path: string
  line: number | null
  side: string | null
  body: string
  author: string
  resolved: number
  created_at: number
  updated_at: number
}

function coerceSide(raw: string | null): GhReviewCommentSide | null {
  return raw === 'LEFT' || raw === 'RIGHT' ? raw : null
}

function fromRow(row: ReviewCommentRow): LocalReviewComment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    prNumber: row.pr_number,
    path: row.path,
    line: row.line,
    side: coerceSide(row.side),
    body: row.body,
    author: row.author,
    resolved: row.resolved === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listByWorkspace(workspaceId: string): LocalReviewComment[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM review_comments WHERE workspace_id = ? ORDER BY created_at ASC')
    .all(workspaceId) as ReviewCommentRow[]
  return rows.map(fromRow)
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface AddReviewCommentInput {
  workspaceId: string
  prNumber?: number | null
  path: string
  line?: number | null
  side?: GhReviewCommentSide | null
  body: string
  /** Defaults to 'you' — local comments have no real GitHub identity. */
  author?: string
}

export function add(input: AddReviewCommentInput): LocalReviewComment {
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  const prNumber = input.prNumber ?? null
  const line = input.line ?? null
  const side = input.side ?? null
  const author = input.author ?? 'you'

  db.prepare(
    `
    INSERT INTO review_comments
      (id, workspace_id, pr_number, path, line, side, body, author, resolved, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `
  ).run(id, input.workspaceId, prNumber, input.path, line, side, input.body, author, now, now)

  return fromRow(
    db.prepare('SELECT * FROM review_comments WHERE id = ?').get(id) as ReviewCommentRow
  )
}

export function setResolved(id: string, resolved: boolean): LocalReviewComment {
  const db = getDb()
  const now = Date.now()
  db.prepare('UPDATE review_comments SET resolved = ?, updated_at = ? WHERE id = ?').run(
    resolved ? 1 : 0,
    now,
    id
  )
  const row = db.prepare('SELECT * FROM review_comments WHERE id = ?').get(id) as
    | ReviewCommentRow
    | undefined
  if (!row) throw new Error(`Local review comment not found: ${id}`)
  return fromRow(row)
}

export function remove(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM review_comments WHERE id = ?').run(id)
}
