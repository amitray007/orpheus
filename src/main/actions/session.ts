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
  SessionLastTurn,
  WorkspaceRecord
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
  // Note: any inFlight entry for this workspace self-cleans via getParsed's
  // own finally block once it settles — no explicit cleanup needed here.
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
  /** Raw bytes held back because they were the start of a not-yet-complete
   *  UTF-8 multi-byte sequence at the end of a chunked read (ACT-6 chunking
   *  can cut a 256KB slice mid-character; a single-shot read never could,
   *  since it always spanned bytesToRead in one call). Empty outside of a
   *  chunk boundary. Prepended (as bytes) to the next chunk's raw buffer
   *  before decoding, so the decoded string is byte-for-byte identical to
   *  decoding the unsplit span in one shot. */
  pendingUtf8Bytes: Buffer

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
// Per-workspace promise chain — serializes concurrent getParsed() calls so
// overlapping advanceAccumulator() passes never interleave writes to the
// same shared AccumulatorState. See runAccumulatorPass()/getParsed() below.
const inFlight = new Map<string, Promise<ParsedSession | null>>()

function newAccumulator(): AccumulatorState {
  return {
    offset: 0,
    inode: -1,
    fileSize: 0,
    tail: '',
    pendingUtf8Bytes: Buffer.alloc(0),
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
  acc.pendingUtf8Bytes = Buffer.alloc(0)
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
    const blocks = content as unknown[]
    for (const block of blocks) {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text') {
        if ('text' in block && typeof block.text === 'string') return block.text
      }
    }
  }
  return null
}

/** Update acc.startedAt / acc.lastMessageAt from a line's timestamp, if valid. */
function updateTimestampBounds(acc: AccumulatorState, ts: number | null): void {
  if (ts && !isNaN(ts)) {
    if (acc.startedAt === null || ts < acc.startedAt) acc.startedAt = ts
    if (acc.lastMessageAt === null || ts > acc.lastMessageAt) acc.lastMessageAt = ts
  }
}

/** Extract sessionId (from system events) and the first-seen model into acc. */
function updateSessionIdentity(
  acc: AccumulatorState,
  parsed: JsonlLine,
  lineModel: string | null
): void {
  if (parsed.type === 'system' && parsed.sessionId) {
    acc.sessionId = parsed.sessionId
  }
  if (lineModel && !acc.model) {
    acc.model = lineModel
  }
}

/** Fold one assistant-turn's usage numbers into acc's running + per-model tallies,
 *  and overwrite the point-in-time context occupancy field. */
function accumulateAssistantUsage(
  acc: AccumulatorState,
  usage: NonNullable<JsonlLine['message']>['usage'],
  lineModelKey: string
): void {
  if (!usage) return
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

/** Process an assistant-role line: turn count, usage accounting, last-text capture. */
function processAssistantLine(
  acc: AccumulatorState,
  parsed: JsonlLine,
  lineModel: string | null,
  ts: number | null
): void {
  acc.turnCount++
  accumulateAssistantUsage(acc, parsed.message?.usage, lineModel ?? acc.model ?? '')

  const text = extractText(parsed.message?.content)
  if (text !== null && ts !== null) {
    acc.lastAssistantText =
      text.length > MAX_TEXT_PREVIEW_BYTES ? text.slice(0, MAX_TEXT_PREVIEW_BYTES) : text
    acc.lastAssistantAt = ts
  }
}

/** Process a user-role line: last-text capture. */
function processUserLine(acc: AccumulatorState, parsed: JsonlLine, ts: number | null): void {
  const text = extractText(parsed.message?.content)
  if (text !== null && ts !== null) {
    acc.lastUserText =
      text.length > MAX_TEXT_PREVIEW_BYTES ? text.slice(0, MAX_TEXT_PREVIEW_BYTES) : text
    acc.lastUserAt = ts
  }
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
  updateTimestampBounds(acc, ts)

  const lineModel = parsed.message?.model ?? parsed.model ?? null
  updateSessionIdentity(acc, parsed, lineModel)

  // Token accounting from assistant message events
  if (parsed.type === 'assistant' || parsed.message?.role === 'assistant') {
    processAssistantLine(acc, parsed, lineModel, ts)
  }

  // User messages
  if (parsed.type === 'user' || parsed.message?.role === 'user') {
    processUserLine(acc, parsed, ts)
  }
}

// PERF (ACT-6): cap each readSync slice so a cold accumulator (offset 0) on a
// multi-MB transcript doesn't block the main thread reading + parsing the
// whole file in one synchronous burst. Chunk boundaries are NOT line
// boundaries — a JSONL line (or even a \r\n pair) can straddle two chunks,
// and a single UTF-8 character can too. Two separate carry-forward
// mechanisms handle this:
//   - acc.pendingUtf8Bytes: raw bytes held back at the END of a chunk when
//     they're the start of an incomplete multi-byte UTF-8 sequence (see
//     lastSafeUtf8Boundary). Prepended, as BYTES, to the next chunk's raw
//     buffer before decoding — so the decoded string is byte-for-byte
//     identical to decoding the unsplit span in one shot. Without this, a
//     multi-byte character split across a 256KB boundary would decode as
//     U+FFFD replacement characters on each side instead of the real glyph.
//   - acc.tail: the existing incomplete-line carry-forward (a decoded
//     string), unchanged — this is the exact same mechanism the
//     incremental accumulator already relies on across separate
//     advanceAccumulator calls as the file grows over time. Chunking here
//     just invokes it more often within one call instead of changing it.
// A stray \r left at a chunk boundary (when \r and \n land in different
// chunks, so the intra-chunk `\r\n` → `\n` regex can't see the pair) is
// still stripped by processLine's `rawLine.trim()`, so line content is
// unaffected either way.
const ACCUMULATOR_CHUNK_BYTES = 256 * 1024

/** Returns the byte offset of the start of any incomplete trailing UTF-8
 *  multi-byte sequence in `buf`, or `buf.length` if the buffer ends on a
 *  complete character (including plain ASCII). Walks back at most 3 bytes
 *  (the longest continuation run before a lead byte in valid UTF-8). */
function lastSafeUtf8Boundary(buf: Buffer): number {
  const len = buf.length
  const maxBack = Math.min(3, len)
  for (let back = 1; back <= maxBack; back++) {
    const b = buf[len - back]
    if (b === undefined) break
    if ((b & 0xc0) !== 0x80) {
      // Not a continuation byte — this is a lead byte (or plain ASCII).
      let seqLen: number
      if ((b & 0x80) === 0x00) seqLen = 1
      else if ((b & 0xe0) === 0xc0) seqLen = 2
      else if ((b & 0xf0) === 0xe0) seqLen = 3
      else if ((b & 0xf8) === 0xf0) seqLen = 4
      else seqLen = 1 // invalid lead byte — don't hold bytes back for it
      return seqLen > back ? len - back : len
    }
  }
  // 3 continuation bytes in a row with no lead byte in the window — not
  // valid UTF-8 within the last 3 bytes; nothing more to hold back.
  return len
}

/** Read up to `maxBytes` starting at `offset` and process complete lines into `acc`,
 *  carrying any trailing partial line forward in `acc.tail` and any trailing partial
 *  UTF-8 character forward in `acc.pendingUtf8Bytes`. Returns the number of bytes
 *  actually read from the file this call (0 at EOF or on read failure) — NOT
 *  including bytes carried over from a previous call's pendingUtf8Bytes. */
function readAndProcessChunk(
  acc: AccumulatorState,
  jsonlPath: string,
  offset: number,
  maxBytes: number
): number {
  let rawBuf: Buffer
  let fd: number | null = null
  try {
    fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(maxBytes)
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, offset)
    if (bytesRead <= 0) return 0
    rawBuf = buf.slice(0, bytesRead)
  } catch {
    return 0
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
  const bytesReadFromFile = rawBuf.length

  // Prepend any incomplete multi-byte sequence held back from the previous
  // chunk, then trim the END of the combined buffer back to a safe
  // character boundary, holding back any new incomplete trailing sequence.
  const withPending =
    acc.pendingUtf8Bytes.length > 0 ? Buffer.concat([acc.pendingUtf8Bytes, rawBuf]) : rawBuf
  const boundary = lastSafeUtf8Boundary(withPending)
  const decodable = withPending.slice(0, boundary)
  acc.pendingUtf8Bytes = withPending.slice(boundary)

  // Advance offset by exactly the bytes read from the file this call — NOT
  // the decoded string length, which can differ from the byte count for
  // non-ASCII content. Bytes held back in pendingUtf8Bytes are still
  // "ingested" (they came from this read); offset tracks file position, not
  // decode progress, so it must include them.
  acc.offset += bytesReadFromFile

  const chunk = decodable.toString('utf8')

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

  return bytesReadFromFile
}

/** Yield control back to the event loop between chunks so a large cold read
 *  doesn't block the main thread for the whole file at once. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Advance the accumulator by reading newly-appended bytes from the file, in
 *  bounded chunks (see ACCUMULATOR_CHUNK_BYTES), yielding to the event loop
 *  between chunks. Returns false only on unrecoverable I/O error (caller
 *  should give up). */
async function advanceAccumulator(acc: AccumulatorState, jsonlPath: string): Promise<boolean> {
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

  let bytesToRead = currentSize - acc.offset
  if (bytesToRead <= 0) {
    // Nothing new to read — accumulator is up to date
    return true
  }

  let first = true
  while (bytesToRead > 0) {
    if (!first) {
      // Only yield BETWEEN chunks, never before the first or after the last —
      // keeps the common (small, warm) case a single synchronous pass.
      await yieldToEventLoop()
    }
    first = false

    const sliceSize = Math.min(bytesToRead, ACCUMULATOR_CHUNK_BYTES)
    const bytesRead = readAndProcessChunk(acc, jsonlPath, acc.offset, sliceSize)
    if (bytesRead <= 0) {
      // Read failed, or returned nothing at an offset stat() said had more
      // bytes (e.g. a racing truncation between statSync and readSync).
      // Treat as unrecoverable for this pass — matches the original
      // single-shot code's behavior on read failure; the next poll's
      // stat() will re-establish ground truth (or trigger the truncation
      // reset above).
      return false
    }
    bytesToRead -= bytesRead
  }

  return true
}

/** Build a ParsedSession from the current accumulator state.
 *  Cost is derived on-demand from per-model token tallies via getPricing. */
function accumulatorToSession(acc: AccumulatorState): ParsedSession {
  const costByModel: Record<string, number> = {}
  // True when a model was tallied (real tokens spent) but has no pricing data
  // — that model's cost is silently excluded from totalCost below, so the UI
  // must be told explicitly rather than reading a possibly-nonzero session as
  // "$0.00" (indistinguishable from genuinely free). See SessionCost.hasUnknownPricing.
  let hasUnknownPricing = false
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
      hasUnknownPricing = true
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
    cost: { usd: totalCost, byModel: costByModel, hasUnknownPricing },
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

/** Critical section: get-or-create the shared accumulator, advance it from the
 *  JSONL file, and derive+cache a ParsedSession. Callers MUST run this only
 *  one-at-a-time per workspaceId (see getParsed's inFlight chain below) —
 *  advanceAccumulator mutates shared AccumulatorState across await points, so
 *  overlapping passes for the same workspace would interleave and corrupt it. */
async function runAccumulatorPass(
  workspaceId: string,
  _ws: WorkspaceRecord,
  jsonlPath: string
): Promise<ParsedSession | null> {
  // Re-check: a prior pass in the same chain may have just refreshed the
  // cache while this call was waiting its turn — skip a redundant re-read.
  const cached = getCached(workspaceId)
  if (cached) return cached

  try {
    let acc = accumulators.get(workspaceId)
    if (!acc) {
      acc = newAccumulator()
      accumulators.set(workspaceId, acc)
    }

    const ok = await advanceAccumulator(acc, jsonlPath)
    if (!ok) return null

    const parsed = accumulatorToSession(acc)
    setCache(workspaceId, parsed)
    return parsed
  } catch (err) {
    console.error('[actions:session] parse failed', { workspaceId, err })
    return null
  }
}

async function getParsed(workspaceId: string): Promise<ParsedSession | null> {
  // Short-circuit: TTL cache avoids even the stat() call during hot windows
  const cached = getCached(workspaceId)
  if (cached) return cached

  const ws = getWorkspace(workspaceId)
  if (!ws?.claudeSessionId) return null

  const jsonlPath = getJsonlPath(ws.cwd, ws.claudeSessionId)
  if (!fs.existsSync(jsonlPath)) return null

  // Serialize concurrent callers for this workspace: chain onto whatever is
  // already in flight so each call gets its own fresh pass after the prior
  // one settles (success or failure), never a raw interleave of two passes
  // sharing the same AccumulatorState.
  const prior = inFlight.get(workspaceId) ?? Promise.resolve(null)
  const next = prior.then(
    () => runAccumulatorPass(workspaceId, ws, jsonlPath),
    () => runAccumulatorPass(workspaceId, ws, jsonlPath)
  )
  inFlight.set(workspaceId, next)

  try {
    return await next
  } finally {
    if (inFlight.get(workspaceId) === next) inFlight.delete(workspaceId)
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
  return { usd: 0, byModel: {}, hasUnknownPricing: false }
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
  const parsed = await getParsed(workspaceId)
  if (!parsed) return { ok: true, value: emptyMeta() }
  return { ok: true, value: parsed.meta }
}

export async function handleGetUsage(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<SessionUsage>> {
  const parsed = await getParsed(workspaceId)
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
  const parsed = await getParsed(workspaceId)
  if (!parsed) return { ok: true, value: emptyCost() }
  return { ok: true, value: parsed.cost }
}

export async function handleGetLastTurn(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<SessionLastTurn>> {
  const parsed = await getParsed(workspaceId)
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
