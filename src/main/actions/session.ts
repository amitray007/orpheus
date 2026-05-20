// ---------------------------------------------------------------------------
// actions/session.ts — Session data readers for Quick Actions
//
// All handlers are kind: 'query'. They parse claude's JSONL transcript files
// on demand, with a 5-second TTL cache keyed by workspaceId.
//
// JSONL path: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Encoding: slashes in cwd become dashes (mirrors claudeSettings.ts:23-31).
//
// Pricing table source: https://www.anthropic.com/api#pricing (accessed 2025-05)
// Rates are per-1M tokens. These are hardcoded to avoid a network dependency;
// update when Anthropic changes the pricing page.
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

// ---------------------------------------------------------------------------
// Pricing table (per 1M tokens, USD)
// Source: https://www.anthropic.com/api#pricing (2025-05)
// ---------------------------------------------------------------------------

type ModelPricing = {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheWritePerMillion: number
}

const PRICING: Record<string, ModelPricing> = {
  // Claude 4 Opus
  'claude-opus-4': {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75
  },
  // Claude 4 Sonnet
  'claude-sonnet-4': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75
  },
  // Claude 3.7 Sonnet
  'claude-sonnet-3-7': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75
  },
  // Claude 3.5 Sonnet / Haiku aliases
  'claude-3-5-sonnet': {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75
  },
  'claude-3-5-haiku': {
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1.0
  },
  // Generic aliases used in Orpheus UI
  sonnet: {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75
  },
  opus: {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75
  },
  haiku: {
    inputPerMillion: 0.8,
    outputPerMillion: 4.0,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1.0
  }
}

/** Resolve pricing for a model string. Falls back to sonnet rates on unknown model. */
function getPricing(model: string): ModelPricing {
  // Try exact match first
  if (PRICING[model]) return PRICING[model]!
  // Try prefix match (e.g. "claude-opus-4-20251215" → "claude-opus-4")
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key]!
  }
  // Final fallback: sonnet rates
  return PRICING['sonnet']!
}

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
// Reads the JSONL line by line (no full read into memory — sessions can be MB+).
// Aggregates into a single ParsedSession object.
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

        // Cost per model
        const lineModelKey = lineModel ?? model ?? 'sonnet'
        const pricing = getPricing(lineModelKey)
        const lineCost =
          (inp / 1_000_000) * pricing.inputPerMillion +
          (out / 1_000_000) * pricing.outputPerMillion +
          (cacheRead / 1_000_000) * pricing.cacheReadPerMillion +
          (cacheCreate / 1_000_000) * pricing.cacheWritePerMillion

        costByModel[lineModelKey] = (costByModel[lineModelKey] ?? 0) + lineCost
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
