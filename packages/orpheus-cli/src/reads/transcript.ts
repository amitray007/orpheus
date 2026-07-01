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
 *
 * ContentPart can be:
 *   { type: 'text', text: '...' }                          — normal text
 *   { type: 'tool_use', name: '...', input: {...} }         — assistant calling a tool
 *   { type: 'tool_result', content: string | Part[], ... }  — result of a tool call,
 *     usually carried on a 'user'-role message (claude's transcript format nests the
 *     tool's output back as a synthetic user turn); tool_result content can itself be
 *     a string or a nested array of parts (commonly more {type:'text'} parts).
 *
 * By default, only text content is surfaced (see NO-FLAGS DEFAULT below). When --full
 * is passed, tool activity (tool_use calls + tool_result outputs) is ALSO included —
 * see TOOL ACTIVITY RENDERING below — so the transcript is genuinely complete for
 * auditing/debugging. Malformed/missing fields are tolerated defensively; bad lines
 * are skipped rather than throwing.
 *
 * TOOL ACTIVITY RENDERING (--full only)
 * --------------------------------------
 * A Turn gets an optional `toolActivity: ToolActivityEntry[]` when --full is set and
 * the underlying message contains tool_use/tool_result parts. Each entry is either:
 *   { kind: 'tool_use', name: string, inputSummary: string }
 *   { kind: 'tool_result', summary: string }
 * `inputSummary` is a compact one-line JSON.stringify of the tool's `input`, truncated
 * to TOOL_SUMMARY_MAX_LEN (200) chars. `summary` for tool_result is the flattened text
 * (string content, or joined text parts, or JSON.stringify as a last resort for
 * non-string/non-array content), also truncated to TOOL_SUMMARY_MAX_LEN chars, with a
 * trailing '…' marker when truncated.
 *
 * Text-mode rendering (renderTurns): each tool_use entry renders as a line
 *   [tool_use: Name] { compact input summary }
 * and each tool_result entry renders as
 *   [tool_result] <summary>
 * interleaved into the turn's text output, after the turn's own text (if any).
 *
 * JSON-mode rendering (--json --full): the Turn objects carry the structured
 * `toolActivity` array as-is (kind/name/inputSummary or kind/summary) rather than
 * flattening to text, so a script can audit tool calls/results programmatically.
 *
 * NO-FLAGS DEFAULT
 * ----------------
 * When no filter flags are given, `ws read` returns the last assistant turn.
 * This is the common "get the result" case — you ran Claude, you want its answer.
 * The default and --last-assistant/--role paths remain TEXT-ONLY (no toolActivity) —
 * tool activity only shows up under --full, per the design above.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { WorkspaceRecord, ProjectRecord } from './db.js'

// ---------------------------------------------------------------------------
// Turn type — the normalized unit of transcript content
// ---------------------------------------------------------------------------

/** Max length (chars) for tool_use input summaries and tool_result summaries. */
export const TOOL_SUMMARY_MAX_LEN = 200

/** A single piece of tool activity attached to a turn (--full only). */
export type ToolActivityEntry =
  | { kind: 'tool_use'; name: string; inputSummary: string }
  | { kind: 'tool_result'; summary: string }

export type Turn = {
  /** 'user' or 'assistant' */
  role: 'user' | 'assistant'
  /** Flattened text content */
  text: string
  /** Unix timestamp in seconds (from the JSONL line's ts field, if present) */
  ts?: number
  /**
   * Tool activity (tool_use calls + tool_result outputs) found on this turn's
   * message. Only populated when parsing with --full — see module doc. Absent
   * (undefined) rather than an empty array when there is no tool activity, so
   * JSON output doesn't grow a noisy `"toolActivity": []` on every plain turn.
   */
  toolActivity?: ToolActivityEntry[]
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

  // Prefer the DB-stored claudeEncodedName — it is the authoritative encoded name
  // written by the app when the project was registered (src/main/projects.ts:
  //   const claudeEncodedName = path.replace(/\//g, '-')
  // i.e. replace '/' with '-', no leading-dash strip).
  // Only fall back to deriving if the DB value is null (pre-migration rows).
  // When deriving, match the app's exact encoding: replace '/' with '-', do NOT
  // strip the leading '-' — an absolute path like /Users/foo starts with '/'
  // which becomes a leading '-', and claude uses that verbatim as the dir name.
  const encoded = project.claudeEncodedName ?? project.path.replace(/\//g, '-')

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

/** Truncate a string to TOOL_SUMMARY_MAX_LEN chars, appending '…' if truncated. */
function truncateSummary(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= TOOL_SUMMARY_MAX_LEN) return collapsed
  return collapsed.slice(0, TOOL_SUMMARY_MAX_LEN) + '…'
}

/**
 * Flatten a tool_result's `content` field to a compact summary string.
 * tool_result content can be a plain string, or an array of parts (usually
 * {type:'text', text}, mirroring message content) — flatten those the same
 * way as parseLineContent. Anything else (object/number/etc.) falls back to
 * a best-effort JSON.stringify so we still produce *something* auditable.
 */
function summarizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return truncateSummary(content)
  if (Array.isArray(content)) {
    const text = parseLineContent(content)
    if (text.trim()) return truncateSummary(text)
    try {
      return truncateSummary(JSON.stringify(content))
    } catch {
      return '(unrenderable tool_result content)'
    }
  }
  if (content == null) return '(empty)'
  try {
    return truncateSummary(JSON.stringify(content))
  } catch {
    return '(unrenderable tool_result content)'
  }
}

/**
 * Extract tool_use / tool_result entries from a message's content array.
 * Tolerates malformed entries (missing name/input/content) by skipping just
 * that entry rather than throwing. Returns undefined (not []) when there is
 * nothing to report, so callers can treat "no tool activity" uniformly.
 */
function extractToolActivity(content: unknown): ToolActivityEntry[] | undefined {
  if (!Array.isArray(content)) return undefined

  const entries: ToolActivityEntry[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const p = part as Record<string, unknown>
    const partType = p['type']

    if (partType === 'tool_use') {
      const name = typeof p['name'] === 'string' && p['name'] !== '' ? p['name'] : '(unknown tool)'
      let inputSummary: string
      try {
        inputSummary = truncateSummary(JSON.stringify(p['input'] ?? {}))
      } catch {
        inputSummary = '(unrenderable input)'
      }
      entries.push({ kind: 'tool_use', name, inputSummary })
    } else if (partType === 'tool_result') {
      const summary = summarizeToolResultContent(p['content'])
      entries.push({ kind: 'tool_result', summary })
    }
  }

  return entries.length > 0 ? entries : undefined
}

function rawLineToTurn(raw: RawLine, includeToolActivity: boolean): Turn | null {
  const type = raw['type']
  if (type !== 'user' && type !== 'assistant') return null

  const message = raw['message']
  if (typeof message !== 'object' || message === null) return null

  const role = (message as Record<string, unknown>)['role']
  if (role !== 'user' && role !== 'assistant') return null

  const content = (message as Record<string, unknown>)['content']
  const text = parseLineContent(content)

  const toolActivity = includeToolActivity ? extractToolActivity(content) : undefined

  // Skip empty turns (tool-only messages produce empty text) UNLESS we're
  // keeping tool activity for --full — a turn with only tool_use/tool_result
  // parts and no text still needs to surface in --full output.
  if (!text.trim() && toolActivity == null) return null

  const turn: Turn = { role, text }
  if (toolActivity != null) turn.toolActivity = toolActivity

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
 * Only user/assistant turns are included; system lines are discarded.
 *
 * Tool activity (tool_use/tool_result) is only extracted when `opts.full` is
 * set (see module doc "TOOL ACTIVITY RENDERING") — otherwise turns with no
 * text content (tool-only messages) are discarded, matching prior behavior
 * for the default/--last-assistant/--role/--last paths.
 */
export function readTranscript(filePath: string, opts: TranscriptOpts = {}): Turn[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return []
  }

  const includeToolActivity = opts.full === true

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
    const turn = rawLineToTurn(parsed as RawLine, includeToolActivity)
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

/** Render a single ToolActivityEntry as one compact text line (no trailing newline). */
function renderToolActivityLine(entry: ToolActivityEntry): string {
  if (entry.kind === 'tool_use') {
    return `[tool_use: ${entry.name}] ${entry.inputSummary}`
  }
  return `[tool_result] ${entry.summary}`
}

/**
 * Render turns as human-readable text output.
 * Each turn is prefixed with the role label and separated by a blank line.
 * When a turn carries `toolActivity` (only present under --full), each entry
 * is rendered as a compact `[tool_use: Name] {...}` / `[tool_result] ...` line
 * after the turn's own text.
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
    if (turn.text.trim()) {
      process.stdout.write(turn.text.trimEnd())
      process.stdout.write('\n')
    }
    if (turn.toolActivity != null) {
      for (const entry of turn.toolActivity) {
        process.stdout.write(renderToolActivityLine(entry))
        process.stdout.write('\n')
      }
    }
    if (i < turns.length - 1) {
      process.stdout.write('\n')
    }
  }
}
