import * as fs from 'node:fs'
import { createInterface } from 'node:readline'
import type {
  ControlReadObservation,
  LastTurnReadModel,
  TranscriptReadModel,
  TranscriptTurnReadModel,
  WorkspaceTranscriptInput
} from './types'

export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
const MAX_TURN_TEXT_BYTES = 64 * 1024
const MAX_TRANSCRIPT_TURNS = 100

type TranscriptOptions = Omit<WorkspaceTranscriptInput, 'workspaceId'> & {
  maxBytes?: number
  observedAt?: number
}

export type TranscriptFileObservation = {
  transcript: ControlReadObservation<TranscriptReadModel>
  lastTurn: ControlReadObservation<LastTurnReadModel>
}

type ParsedTurn = {
  turn: TranscriptTurnReadModel
  textTruncated: boolean
}

type ToolActivity = NonNullable<TranscriptTurnReadModel['toolActivity']>[number]

type ScanState = {
  turns: TranscriptTurnReadModel[]
  bytesRead: number
  truncated: boolean
  lastUserText: string | null
  lastAssistantText: string | null
  lastUserAt: number | null
  lastAssistantAt: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value: string): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value)
  if (bytes <= MAX_TURN_TEXT_BYTES) return { value, truncated: false }

  const buffer = Buffer.from(value)
  return {
    value: buffer.subarray(0, MAX_TURN_TEXT_BYTES).toString('utf8'),
    truncated: true
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function blockText(block: Record<string, unknown>): string | null {
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return null
}

function toolSummary(block: Record<string, unknown>): ToolActivity | null {
  if (block.type === 'tool_use') {
    return {
      kind: 'tool_use',
      ...(typeof block.name === 'string' ? { name: block.name } : {}),
      summary: typeof block.name === 'string' ? `Used ${block.name}` : 'Used a tool'
    }
  }
  if (block.type !== 'tool_result') return null

  return { kind: 'tool_result', summary: 'Tool returned a result' }
}

function parseContent(
  content: unknown,
  includeToolActivity: boolean
): { text: string; toolActivity: ToolActivity[] } {
  const textParts: string[] = []
  const toolActivity: ToolActivity[] = []

  if (typeof content === 'string') {
    textParts.push(content)
  }
  if (!Array.isArray(content)) return { text: textParts.join('\n'), toolActivity }

  for (const candidate of content) {
    if (!isRecord(candidate)) continue
    const text = blockText(candidate)
    if (text != null) textParts.push(text)
    const tool = includeToolActivity ? toolSummary(candidate) : null
    if (tool != null) toolActivity.push(tool)
  }
  return { text: textParts.join('\n'), toolActivity }
}

function parseTurn(value: unknown, includeToolActivity: boolean): ParsedTurn | null {
  if (!isRecord(value)) return null
  const message = isRecord(value.message) ? value.message : null
  const rawRole = message?.role ?? value.role ?? value.type
  if (rawRole !== 'user' && rawRole !== 'assistant') return null

  const content = parseContent(message?.content ?? value.content, includeToolActivity)
  if (content.text.length === 0 && content.toolActivity.length === 0) return null
  const text = boundedText(content.text)
  return {
    turn: {
      role: rawRole,
      text: text.value,
      timestamp: parseTimestamp(value.timestamp),
      ...(content.toolActivity.length > 0 ? { toolActivity: content.toolActivity } : {})
    },
    textTruncated: text.truncated
  }
}

function unavailableObservation(observedAt: number, reason: string): TranscriptFileObservation {
  const shared = {
    source: 'claude-jsonl' as const,
    observedAt,
    sourceUpdatedAt: null,
    availability: 'unavailable' as const,
    stale: null,
    reason
  }
  return {
    transcript: { ...shared, value: null },
    lastTurn: { ...shared, value: null }
  }
}

function parseJsonLine(line: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) as unknown }
  } catch {
    return { ok: false }
  }
}

function rememberLastTurn(state: ScanState, turn: TranscriptTurnReadModel): void {
  if (turn.text.length === 0) return
  if (turn.role === 'user') {
    state.lastUserText = turn.text
    state.lastUserAt = turn.timestamp
    return
  }
  state.lastAssistantText = turn.text
  state.lastAssistantAt = turn.timestamp
}

function matchesFilters(turn: TranscriptTurnReadModel, options: TranscriptOptions): boolean {
  if (options.role != null && turn.role !== options.role) return false
  return options.since == null || (turn.timestamp != null && turn.timestamp >= options.since)
}

function processJsonLine(
  line: string,
  state: ScanState,
  options: TranscriptOptions,
  limit: number
): void {
  if (line.trim().length === 0) return
  const parsed = parseJsonLine(line)
  if (!parsed.ok) {
    state.truncated = true
    return
  }
  const parsedTurn = parseTurn(parsed.value, options.includeToolActivity === true)
  if (parsedTurn == null) return
  if (parsedTurn.textTruncated) state.truncated = true
  rememberLastTurn(state, parsedTurn.turn)
  if (!matchesFilters(parsedTurn.turn, options)) return
  state.turns.push(parsedTurn.turn)
  if (state.turns.length > limit) state.turns.shift()
}

async function scanTranscript(
  jsonlPath: string,
  start: number,
  size: number,
  options: TranscriptOptions,
  limit: number
): Promise<ScanState> {
  const state: ScanState = {
    turns: [],
    bytesRead: 0,
    truncated: start > 0,
    lastUserText: null,
    lastAssistantText: null,
    lastUserAt: null,
    lastAssistantAt: null
  }
  let skipPartialFirstLine = start > 0
  const stream = fs.createReadStream(jsonlPath, {
    start,
    end: size > 0 ? size - 1 : 0,
    highWaterMark: 64 * 1024
  })
  stream.on('data', (chunk: Buffer | string) => {
    state.bytesRead += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
  })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (skipPartialFirstLine) {
      skipPartialFirstLine = false
    } else {
      processJsonLine(line, state, options, limit)
    }
  }
  return state
}

export async function observeTranscriptFile(
  jsonlPath: string | null,
  options: TranscriptOptions = {}
): Promise<TranscriptFileObservation> {
  const observedAt = options.observedAt ?? Date.now()
  if (jsonlPath == null) {
    return unavailableObservation(observedAt, 'Workspace has no Claude conversation transcript.')
  }

  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(jsonlPath)
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown'
    const reason =
      code === 'ENOENT'
        ? 'Claude transcript file does not exist yet.'
        : `Claude transcript is unavailable (${code}).`
    return unavailableObservation(observedAt, reason)
  }

  if (!stat.isFile()) {
    return unavailableObservation(observedAt, 'Claude transcript path is not a regular file.')
  }

  const requestedBytes = Math.floor(options.maxBytes ?? MAX_TRANSCRIPT_BYTES)
  const maxBytes = Math.max(1, Math.min(requestedBytes, MAX_TRANSCRIPT_BYTES))
  const start = Math.max(0, stat.size - maxBytes)
  const limit = Math.max(1, Math.min(options.limit ?? 20, MAX_TRANSCRIPT_TURNS))

  let state: ScanState
  try {
    state = await scanTranscript(jsonlPath, start, stat.size, options, limit)
  } catch (error) {
    return unavailableObservation(
      observedAt,
      `Claude transcript could not be read (${error instanceof Error ? error.message : String(error)}).`
    )
  }

  const shared = {
    source: 'claude-jsonl' as const,
    observedAt,
    sourceUpdatedAt: stat.mtimeMs,
    availability: 'available' as const,
    stale: false
  }
  return {
    transcript: {
      ...shared,
      value: {
        turns: state.turns,
        truncated: state.truncated,
        bytesRead: state.bytesRead
      }
    },
    lastTurn: {
      ...shared,
      value: {
        userText: state.lastUserText,
        assistantText: state.lastAssistantText,
        userAt: state.lastUserAt,
        assistantAt: state.lastAssistantAt
      }
    }
  }
}
