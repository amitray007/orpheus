/**
 * reads/transcript.ts — JSONL transcript parsing and rendering for the Orpheus CLI.
 *
 * TRANSCRIPT LOCATION
 * -------------------
 * Claude Code writes transcripts to:
 *   ~/.claude/projects/<encodedProjectPath>/<claudeSessionId>.jsonl
 *
 * The encoded project path is derived from the project's cwd by replacing '/'
 * with '-'. This is stored in the DB as ProjectRecord.claudeEncodedName.
 *
 * JSONL FORMAT
 * ------------
 * Each line is a JSON object. Relevant shapes:
 *   { type: 'user'|'assistant', message: { role: string, content: string | ContentPart[] } }
 *   { type: 'system', ... }  (ignored)
 *   tool result lines         (ignored)
 *
 * ContentPart is { type: string, text?: string } — we join text blocks.
 *
 * NO-FLAGS DEFAULT
 * ----------------
 * When no filter flags are given, `ws read` returns the last assistant turn.
 * This is the common "get the result" case — you ran Claude, you want its answer.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { WorkspaceRecord, ProjectRecord } from './db.js'

// ---------------------------------------------------------------------------
// Turn type — the normalized unit of transcript content
// ---------------------------------------------------------------------------

export type Turn = {
  /** 'user' or 'assistant' */
  role: 'user' | 'assistant'
  /** Flattened text content */
  text: string
  /** Unix timestamp in seconds (from the JSONL line's ts field, if present) */
  ts?: number
}

// ---------------------------------------------------------------------------
// Filter / shaping options
// ---------------------------------------------------------------------------

export type TranscriptOpts = {
  /** Only return the final assistant turn (default when no other flags given). */
  lastAssistant?: boolean
  /** Return only the last N turns. */
  last?: number
  /** Return all turns (override the default). */
  full?: boolean
  /** Filter to only this role. */
  role?: 'user' | 'assistant'
  /** Only turns at or after this Unix timestamp (seconds). */
  since?: number
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Build the path to the JSONL transcript for a workspace.
 *
 * Returns null if the workspace has no claudeSessionId yet (session not
 * started), or if the project has no encoded name (shouldn't happen in
 * practice but guard defensively).
 */
export function resolveTranscriptPath(
  workspace: WorkspaceRecord,
  project: ProjectRecord
): string | null {
  if (workspace.claudeSessionId == null) return null

  // claudeEncodedName is stored in the DB; fall back to deriving it from the
  // project path (replace all '/' with '-', strip leading '-').
  const encoded = project.claudeEncodedName ?? project.path.replaceAll('/', '-').replace(/^-/, '')

  if (!encoded) return null

  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    encoded,
    `${workspace.claudeSessionId}.jsonl`
  )
}

// ---------------------------------------------------------------------------
// Raw line parsing helpers
// ---------------------------------------------------------------------------

type RawLine = Record<string, unknown>

function parseLineContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (
        typeof part === 'object' &&
        part !== null &&
        (part as Record<string, unknown>)['type'] === 'text'
      ) {
        const t = (part as Record<string, unknown>)['text']
        if (typeof t === 'string') parts.push(t)
      }
    }
    return parts.join('')
  }
  return ''
}

function rawLineToTurn(raw: RawLine): Turn | null {
  const type = raw['type']
  if (type !== 'user' && type !== 'assistant') return null

  const message = raw['message']
  if (typeof message !== 'object' || message === null) return null

  const role = (message as Record<string, unknown>)['role']
  if (role !== 'user' && role !== 'assistant') return null

  const content = (message as Record<string, unknown>)['content']
  const text = parseLineContent(content)

  // Skip empty turns (tool-only messages produce empty text)
  if (!text.trim()) return null

  const turn: Turn = { role, text }

  const ts = raw['ts']
  if (typeof ts === 'number') turn.ts = ts

  return turn
}

// ---------------------------------------------------------------------------
// Transcript reading
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL transcript file into an array of Turns.
 *
 * Robust parsing: malformed or truncated lines are silently skipped.
 * Only user/assistant turns with non-empty text content are included;
 * tool results, system lines, and empty messages are discarded.
 */
export function readTranscript(filePath: string, opts: TranscriptOpts = {}): Turn[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  // Parse all valid lines into turns
  const allTurns: Turn[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const turn = rawLineToTurn(parsed as RawLine)
    if (turn != null) allTurns.push(turn)
  }

  // Apply filters
  return applyOpts(allTurns, opts)
}

// ---------------------------------------------------------------------------
// Filter application
// ---------------------------------------------------------------------------

/**
 * Apply TranscriptOpts filters to a list of turns.
 *
 * Priority / logic:
 *  1. role filter — applied first to narrow the dataset
 *  2. since filter — applied to the (potentially role-filtered) dataset
 *  3. lastAssistant — return only the final assistant turn (ignores last/full)
 *  4. last N — return last N turns from the filtered set
 *  5. full — return everything
 *  6. default (no flags) — lastAssistant behaviour
 */
export function applyOpts(turns: Turn[], opts: TranscriptOpts): Turn[] {
  let filtered = turns

  // Role filter
  if (opts.role != null) {
    filtered = filtered.filter((t) => t.role === opts.role)
  }

  // Since filter
  if (opts.since != null) {
    const since = opts.since
    filtered = filtered.filter((t) => t.ts == null || t.ts >= since)
  }

  // lastAssistant (explicit flag)
  if (opts.lastAssistant === true) {
    const last = [...filtered].reverse().find((t) => t.role === 'assistant')
    return last != null ? [last] : []
  }

  // last N
  if (opts.last != null && opts.last > 0) {
    return filtered.slice(-opts.last)
  }

  // full
  if (opts.full === true) {
    return filtered
  }

  // Default: last assistant turn (the "get the result" case)
  const lastAssistant = [...filtered].reverse().find((t) => t.role === 'assistant')
  return lastAssistant != null ? [lastAssistant] : []
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ROLE_LABEL: Record<Turn['role'], string> = {
  user: 'You',
  assistant: 'Claude'
}

/**
 * Render turns as human-readable text output.
 * Each turn is prefixed with the role label and separated by a blank line.
 */
export function renderTurns(turns: Turn[]): void {
  if (turns.length === 0) {
    process.stdout.write('(no turns)\n')
    return
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!
    const label = ROLE_LABEL[turn.role]
    process.stdout.write(`[${label}]\n`)
    process.stdout.write(turn.text.trimEnd())
    process.stdout.write('\n')
    if (i < turns.length - 1) {
      process.stdout.write('\n')
    }
  }
}
