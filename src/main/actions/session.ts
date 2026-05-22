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
import { getWorkspace } from '../workspaces'
import { getPricing } from '../pricing'

// ---------------------------------------------------------------------------
// Parse cache with 5-second TTL
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
const TTL_MS = 5000

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

/** Invalidate a workspace's cached parse result. Called by subscriptions on file change. */
export function invalidateSessionCache(workspaceId: string): void {
  parseCache.delete(workspaceId)
}

// ---------------------------------------------------------------------------
// JSONL path resolution
// ---------------------------------------------------------------------------

function getJsonlPath(cwd: string, sessionId: string): string {
  const encoded = cwd.replace(/\//g, '-')
  return nodePath.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
}

// ---------------------------------------------------------------------------
// Aggregate parse
//
// Reads the entire JSONL into memory via readFileSync then splits on newlines.
// A 5-second TTL cache (parseCache) limits repeat reads to at most one per 5s
// per workspace. Subscriptions invalidate the cache on each file-change event
// (debounced 200ms) so live updates are low-latency without true streaming.
//
// TODO: replace with a line-buffered streaming read for very large sessions.
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

function parseJsonl(jsonlPath: string): ParsedSession {
  const raw = fs.readFileSync(jsonlPath, 'utf8')
  const lines = raw.split('\n')

  // Aggregation state
  let sessionId: string | null = null
  let model: string | null = null
  let startedAt: number | null = null
  let lastMessageAt: number | null = null
  let turnCount = 0

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0

  const costByModel: Record<string, number> = {}

  let lastUserText: string | null = null
  let lastUserAt: number | null = null
  let lastAssistantText: string | null = null
  let lastAssistantAt: number | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    let parsed: JsonlLine
    try {
      parsed = JSON.parse(line) as JsonlLine
    } catch {
      continue
    }

    const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : null
    if (ts && !isNaN(ts)) {
      if (startedAt === null || ts < startedAt) startedAt = ts
      if (lastMessageAt === null || ts > lastMessageAt) lastMessageAt = ts
    }

    // Session ID and model from system events
    if (parsed.type === 'system' && parsed.sessionId) {
      sessionId = parsed.sessionId
    }

    const lineModel = parsed.message?.model ?? parsed.model ?? null
    if (lineModel && !model) {
      model = lineModel
    }

    // Token accounting from assistant message events
    if (parsed.type === 'assistant' || parsed.message?.role === 'assistant') {
      turnCount++
      const usage = parsed.message?.usage
      if (usage) {
        const inp = usage.input_tokens ?? 0
        const out = usage.output_tokens ?? 0
        const cacheRead = usage.cache_read_input_tokens ?? 0
        const cacheCreate = usage.cache_creation_input_tokens ?? 0

        inputTokens += inp
        outputTokens += out
        cacheReadTokens += cacheRead
        cacheCreationTokens += cacheCreate

        // Cost per model — skip if pricing is unknown (avoids double-counting with stale data)
        const lineModelKey = lineModel ?? model ?? ''
        if (lineModelKey) {
          const pricing = getPricing(lineModelKey)
          if (pricing) {
            const lineCost =
              (inp / 1_000_000) * pricing.input +
              (out / 1_000_000) * pricing.output +
              (cacheRead / 1_000_000) * pricing.cacheRead +
              (cacheCreate / 1_000_000) * pricing.cacheWrite

            costByModel[lineModelKey] = (costByModel[lineModelKey] ?? 0) + lineCost
          } else {
            console.warn(`[actions:session] unknown model for cost accounting: ${lineModelKey}`)
          }
        }
      }

      const text = extractText(parsed.message?.content)
      if (text !== null && ts !== null) {
        lastAssistantText = text
        lastAssistantAt = ts
      }
    }

    // User messages
    if (parsed.type === 'user' || parsed.message?.role === 'user') {
      const text = extractText(parsed.message?.content)
      if (text !== null && ts !== null) {
        lastUserText = text
        lastUserAt = ts
      }
    }
  }

  const totalCost = Object.values(costByModel).reduce((a, b) => a + b, 0)

  return {
    meta: {
      sessionId: sessionId ?? '',
      model: model ?? '',
      startedAt: startedAt ?? 0,
      lastMessageAt,
      turnCount
    },
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      contextBudget: 0, // filled in by getUsage — needs workspace context
      usedPct: 0
    },
    cost: { usd: totalCost, byModel: costByModel },
    lastTurn: {
      userText: lastUserText,
      assistantText: lastAssistantText,
      userAt: lastUserAt,
      assistantAt: lastAssistantAt
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
  const cached = getCached(workspaceId)
  if (cached) return cached

  const ws = getWorkspace(workspaceId)
  if (!ws?.claudeSessionId) return null

  const jsonlPath = getJsonlPath(ws.cwd, ws.claudeSessionId)
  if (!fs.existsSync(jsonlPath)) return null

  try {
    const parsed = parseJsonl(jsonlPath)
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

  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = parsed.usage
  const usedPct =
    contextBudget > 0
      ? ((inputTokens + cacheReadTokens + cacheCreationTokens) / contextBudget) * 100
      : 0

  return {
    ok: true,
    value: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
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
