// ---------------------------------------------------------------------------
// actions/session.ts — Session data readers for Quick Actions
//
// All handlers are kind: 'query'. They parse claude's JSONL transcript files
// on demand, with a 5-second TTL cache keyed by workspaceId.
//
// JSONL path: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Encoding: slashes in cwd become dashes (mirrors claudeSettings.ts:23-31).
//
// Pricing is delegated to src/main/pricing.ts which fetches live data from
// models.dev at boot and falls back to a hardcoded table for offline use.
//
// Incremental parsing: instead of reading the whole file on every cache miss,
// an AccumulatorState per workspace tracks the byte offset consumed so far.
// Only newly-appended bytes are read. On truncation or inode change the
// accumulator resets and re-reads from byte 0.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type {
  ActionResult,
  SessionMeta,
  SessionUsage,
  SessionCost,
  SessionLastTurn
} from '../../shared/types'
import { getClaudeGlobalSettings } from '../claudeSettings'
import { encodePathToClaudeDir } from '../claudeProjectDir'
import { getWorkspace } from '../workspaces'
import { getPricing } from '../pricing'

// ---------------------------------------------------------------------------
// Parse cache — short-circuit repeated reads within the TTL window
// ---------------------------------------------------------------------------

type ParsedSession = {
  meta: SessionMeta
  usage: SessionUsage
  cost: SessionCost
  lastTurn: SessionLastTurn
}

type CacheEntry = {
  data: ParsedSession
  expiresAt: number
}

const parseCache = new Map<string, CacheEntry>()
const TTL_MS = 30_000 // raised from 5s to reduce synchronous full-file reads under load

function getCached(workspaceId: string): ParsedSession | null {
  const entry = parseCache.get(workspaceId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    parseCache.delete(workspaceId)
    return null
  }
  return entry.data
}

function setCache(workspaceId: string, data: ParsedSession): void {
  parseCache.set(workspaceId, { data, expiresAt: Date.now() + TTL_MS })
}

/** Invalidate a workspace's cached parse result. Called by subscriptions on file change.
 *  Clears the derived ParsedSession cache so the next read re-derives from the
 *  accumulator (which is still valid — only a truncation/inode change resets it). */
export function invalidateSessionCache(workspaceId: string): void {
  parseCache.delete(workspaceId)
}

/** Evict a workspace's JSONL accumulator and parse cache — called at archive time
 *  so dead workspaces don't grow the in-memory accumulator map unboundedly. */
export function evictAccumulator(workspaceId: string): void {
  accumulators.delete(workspaceId)
  parseCache.delete(workspaceId)
}

// ---------------------------------------------------------------------------
// JSONL path resolution
// ---------------------------------------------------------------------------

function getJsonlPath(cwd: string, sessionId: string): string {
  const encoded = encodePathToClaudeDir(cwd)
  return nodePath.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
}

// ---------------------------------------------------------------------------
// Incremental accumulator
//
// One AccumulatorState per workspace. Stores running aggregates and the file
// position consumed so far. On each getParsed call we stat the file, read
// only the new bytes [offset, size), split on newlines, process complete
// lines, and save any incomplete trailing fragment for the next call.
//
// Per-model token tallies are stored raw; cost is derived at read time via
// getPricing so late-loaded or updated pricing is always reflected.
// ---------------------------------------------------------------------------

// Minimal JSONL line shape — only the fields we actually access.
type JsonlLine = {
  type?: string
  role?: string
  sessionId?: string
  message?: {
    role?: string
    content?: unknown
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
    model?: string
  }
  model?: string
  timestamp?: string
  // Summary / system events
  summary?: string
}

// Per-model raw token tallies (cost derived on demand from these).
type ModelTokens = {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

// Running aggregates. Does NOT store all lines — only scalars + last texts.
type AccumulatorState = {
  // File identity / position
  offset: number // bytes ingested so far (tail included)
  inode: number // inode at last stat — rotation/replacement detection
  fileSize: number // size at last stat (for truncation detection)
  tail: string // incomplete line fragment after the last newline

  // Aggregates (updated incrementally)
  sessionId: string | null
  model: string | null
  startedAt: number | null
  lastMessageAt: number | null
  turnCount: number

  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number

  /** Point-in-time context occupancy from the MOST RECENT assistant turn only.
   *  Overwritten each turn (not accumulated). Used for the context chip. */
  lastTurnContextTokens: number

  // Per-model token tallies for deferred cost computation
  tokensByModel: Map<string, ModelTokens>

  // Last-wins text fields — capped to MAX_TEXT_PREVIEW_BYTES
  lastUserText: string | null
  lastUserAt: number | null
  lastAssistantText: string | null
  lastAssistantAt: number | null
}

// Cap preview text to 4 KB — keeps the accumulator memory-bounded.
const MAX_TEXT_PREVIEW_BYTES = 4096

const accumulators = new Map<string, AccumulatorState>()

function newAccumulator(): AccumulatorState {
  return {
    offset: 0,
    inode: -1,
    fileSize: 0,
    tail: '',
    sessionId: null,
    model: null,
    startedAt: null,
    lastMessageAt: null,
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    lastTurnContextTokens: 0,
    tokensByModel: new Map(),
    lastUserText: null,
    lastUserAt: null,
    lastAssistantText: null,
    lastAssistantAt: null
  }
}

function resetAccumulator(acc: AccumulatorState): void {
  acc.offset = 0
  acc.inode = -1
  acc.fileSize = 0
  acc.tail = ''
  acc.sessionId = null
  acc.model = null
  acc.startedAt = null
  acc.lastMessageAt = null
  acc.turnCount = 0
  acc.inputTokens = 0
  acc.outputTokens = 0
  acc.cacheReadTokens = 0
  acc.cacheCreationTokens = 0
  acc.lastTurnContextTokens = 0
  acc.tokensByModel.clear()
  acc.lastUserText = null
  acc.lastUserAt = null
  acc.lastAssistantText = null
  acc.lastAssistantAt = null
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text') {
        if ('text' in block && typeof block.text === 'string') return block.text
      }
    }
  }
  return null
}

/** Process a single complete JSONL line string into the accumulator. */
function processLine(acc: AccumulatorState, rawLine: string): void {
  const line = rawLine.trim()
  if (!line) return

  let parsed: JsonlLine
  try {
    parsed = JSON.parse(line) as JsonlLine
  } catch {
    return
  }

  const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : null
  if (ts && !isNaN(ts)) {
    if (acc.startedAt === null || ts < acc.startedAt) acc.startedAt = ts
    if (acc.lastMessageAt === null || ts > acc.lastMessageAt) acc.lastMessageAt = ts
  }

  // Session ID and model from system events
  if (parsed.type === 'system' && parsed.sessionId) {
    acc.sessionId = parsed.sessionId
  }

  const lineModel = parsed.message?.model ?? parsed.model ?? null
  if (lineModel && !acc.model) {
    acc.model = lineModel
  }

  // Token accounting from assistant message events
  if (parsed.type === 'assistant' || parsed.message?.role === 'assistant') {
    acc.turnCount++
    const usage = parsed.message?.usage
    if (usage) {
      const inp = usage.input_tokens ?? 0
      const out = usage.output_tokens ?? 0
      const cacheRead = usage.cache_read_input_tokens ?? 0
      const cacheCreate = usage.cache_creation_input_tokens ?? 0

      acc.inputTokens += inp
      acc.outputTokens += out
      acc.cacheReadTokens += cacheRead
      acc.cacheCreationTokens += cacheCreate

      // Point-in-time context occupancy: OVERWRITE each turn (not cumulative).
      // Used for the footer context chip — reflects only the current turn's window.
      // Includes output: matches claude's /context, where the turn's response is
      // resident in the window (the next turn's input+cache absorbs it).
      acc.lastTurnContextTokens = inp + cacheRead + cacheCreate + out

      // Accumulate per-model token tallies for deferred cost computation
      const lineModelKey = lineModel ?? acc.model ?? ''
      if (lineModelKey) {
        let mt = acc.tokensByModel.get(lineModelKey)
        if (!mt) {
          mt = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
          acc.tokensByModel.set(lineModelKey, mt)
        }
        mt.input += inp
        mt.output += out
        mt.cacheRead += cacheRead
        mt.cacheCreate += cacheCreate
      }
    }

    const text = extractText(parsed.message?.content)
    if (text !== null && ts !== null) {
      acc.lastAssistantText =
        text.length > MAX_TEXT_PREVIEW_BYTES ? text.slice(0, MAX_TEXT_PREVIEW_BYTES) : text
      acc.lastAssistantAt = ts
    }
  }

  // User messages
  if (parsed.type === 'user' || parsed.message?.role === 'user') {
    const text = extractText(parsed.message?.content)
    if (text !== null && ts !== null) {
      acc.lastUserText =
        text.length > MAX_TEXT_PREVIEW_BYTES ? text.slice(0, MAX_TEXT_PREVIEW_BYTES) : text
      acc.lastUserAt = ts
    }
  }
}

/** Advance the accumulator by reading newly-appended bytes from the file.
 *  Returns false only on unrecoverable I/O error (caller should give up). */
function advanceAccumulator(acc: AccumulatorState, jsonlPath: string): boolean {
  let stat: fs.Stats
  try {
    stat = fs.statSync(jsonlPath)
  } catch {
    return false
  }

  const currentInode = stat.ino
  const currentSize = stat.size

  // Detect rotation/replacement (inode change) or truncation (size shrank)
  const inodeChanged = acc.inode !== -1 && currentInode !== acc.inode
  const truncated = currentSize < acc.offset
  if (inodeChanged || truncated) {
    resetAccumulator(acc)
  }

  // Record file identity
  acc.inode = currentInode
  acc.fileSize = currentSize

  const bytesToRead = currentSize - acc.offset
  if (bytesToRead <= 0) {
    // Nothing new to read — accumulator is up to date
    return true
  }

  // Read only the new bytes
  let chunk: string
  let fd: number | null = null
  try {
    fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(bytesToRead)
    const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, acc.offset)
    chunk = buf.slice(0, bytesRead).toString('utf8')
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }

  // Advance offset unconditionally — offset tracks how many file bytes have been
  // ingested (tail included), NOT the last-newline boundary. On the next read we
  // start here and prepend acc.tail so the incomplete fragment is re-joined.
  acc.offset += bytesToRead

  // Normalize \r\n to \n so the split works correctly
  const combined = acc.tail + chunk.replace(/\r\n/g, '\n')

  // Split on newlines — the last fragment may be an incomplete line
  const parts = combined.split('\n')

  // Everything except the last element is a complete line
  const completeLines = parts.slice(0, -1)
  // The last element is either empty (if combined ended with '\n') or a partial line
  acc.tail = parts[parts.length - 1]

  for (const rawLine of completeLines) {
    processLine(acc, rawLine)
  }

  return true
}

/** Build a ParsedSession from the current accumulator state.
 *  Cost is derived on-demand from per-model token tallies via getPricing. */
function accumulatorToSession(acc: AccumulatorState): ParsedSession {
  const costByModel: Record<string, number> = {}
  for (const [modelKey, mt] of acc.tokensByModel) {
    const pricing = getPricing(modelKey)
    if (pricing) {
      const lineCost =
        (mt.input / 1_000_000) * pricing.input +
        (mt.output / 1_000_000) * pricing.output +
        (mt.cacheRead / 1_000_000) * pricing.cacheRead +
        (mt.cacheCreate / 1_000_000) * pricing.cacheWrite
      costByModel[modelKey] = lineCost
    } else {
      console.warn(`[actions:session] unknown model for cost accounting: ${modelKey}`)
    }
  }

  const totalCost = Object.values(costByModel).reduce((a, b) => a + b, 0)

  return {
    meta: {
      sessionId: acc.sessionId ?? '',
      model: acc.model ?? '',
      startedAt: acc.startedAt ?? 0,
      lastMessageAt: acc.lastMessageAt,
      turnCount: acc.turnCount
    },
    usage: {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      lastTurnContextTokens: acc.lastTurnContextTokens,
      contextBudget: 0, // filled in by getUsage — needs workspace context
      usedPct: 0
    },
    cost: { usd: totalCost, byModel: costByModel },
    lastTurn: {
      userText: acc.lastUserText,
      assistantText: acc.lastAssistantText,
      userAt: acc.lastUserAt,
      assistantAt: acc.lastAssistantAt
    }
  }
}

// ---------------------------------------------------------------------------
// Effective maxContextTokens for a workspace
//
// Reads global settings; workspace-level overrides don't expose maxContextTokens
// (they only carry model/permissionMode/effort), so global is the final answer.
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_BUDGET = 200_000

function getEffectiveContextBudget(): number {
  try {
    const global = getClaudeGlobalSettings()
    return global.maxContextTokens ?? DEFAULT_CONTEXT_BUDGET
  } catch {
    return DEFAULT_CONTEXT_BUDGET
  }
}

// ---------------------------------------------------------------------------
// Shared parse entrypoint
// ---------------------------------------------------------------------------

function getParsed(workspaceId: string): ParsedSession | null {
  // Short-circuit: TTL cache avoids even the stat() call during hot windows
  const cached = getCached(workspaceId)
  if (cached) return cached

  const ws = getWorkspace(workspaceId)
  if (!ws?.claudeSessionId) return null

  const jsonlPath = getJsonlPath(ws.cwd, ws.claudeSessionId)
  if (!fs.existsSync(jsonlPath)) return null

  try {
    let acc = accumulators.get(workspaceId)
    if (!acc) {
      acc = newAccumulator()
      accumulators.set(workspaceId, acc)
    }

    const ok = advanceAccumulator(acc, jsonlPath)
    if (!ok) return null

    const parsed = accumulatorToSession(acc)
    setCache(workspaceId, parsed)
    return parsed
  } catch (err) {
    console.error('[actions:session] parse failed', { workspaceId, err })
    return null
  }
}

// ---------------------------------------------------------------------------
// Empty aggregates — returned when the session hasn't started yet
// ---------------------------------------------------------------------------

function emptyMeta(): SessionMeta {
  return { sessionId: '', model: '', startedAt: 0, lastMessageAt: null, turnCount: 0 }
}

function emptyUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    lastTurnContextTokens: 0,
    contextBudget: getEffectiveContextBudget(),
    usedPct: 0
  }
}

function emptyCost(): SessionCost {
  return { usd: 0, byModel: {} }
}

function emptyLastTurn(): SessionLastTurn {
  return { userText: null, assistantText: null, userAt: null, assistantAt: null }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

export async function handleGetMeta(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<SessionMeta>> {
  const parsed = getParsed(workspaceId)
  if (!parsed) return { ok: true, value: emptyMeta() }
  return { ok: true, value: parsed.meta }
}

export async function handleGetUsage(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<SessionUsage>> {
  const parsed = getParsed(workspaceId)
  const contextBudget = getEffectiveContextBudget()

  if (!parsed) {
    return { ok: true, value: { ...emptyUsage(), contextBudget } }
  }

  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, lastTurnContextTokens } =
    parsed.usage
  // Use the most-recent turn's context occupancy (not cumulative) so the chip
  // reflects the current window size, not a monotonically-growing sum.
  const usedPct =
    contextBudget > 0 ? Math.min((lastTurnContextTokens / contextBudget) * 100, 100) : 0

  return {
    ok: true,
    value: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      lastTurnContextTokens,
      contextBudget,
      usedPct: Math.min(usedPct, 100)
    }
  }
}

export async function handleGetCost(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<SessionCost>> {
  const parsed = getParsed(workspaceId)
  if (!parsed) return { ok: true, value: emptyCost() }
  return { ok: true, value: parsed.cost }
}

export async function handleGetLastTurn(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<SessionLastTurn>> {
  const parsed = getParsed(workspaceId)
  if (!parsed) return { ok: true, value: emptyLastTurn() }
  return { ok: true, value: parsed.lastTurn }
}

// ---------------------------------------------------------------------------
// JSONL path accessor — exported for subscriptions.ts
// ---------------------------------------------------------------------------

export function resolveJsonlPath(workspaceId: string): string | null {
  const ws = getWorkspace(workspaceId)
  if (!ws?.claudeSessionId) return null
  return getJsonlPath(ws.cwd, ws.claudeSessionId)
}
