import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { ClaudeHookEntry, ClaudeHookDraft } from '../shared/types'
import { listProjects } from './projects'

const EVENT_ORDER = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification'
]

function eventRank(event: string): number {
  const idx = EVENT_ORDER.indexOf(event)
  return idx === -1 ? EVENT_ORDER.length : idx
}

function parseHooksFile(
  filePath: string,
  base: Omit<
    ClaudeHookEntry,
    'event' | 'matcher' | 'type' | 'command' | 'matcherEntryIdx' | 'hookIdx'
  >
): ClaudeHookEntry[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    // File missing or unreadable — not an error, just nothing to show
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn('[claudeHooks] failed to parse', filePath, err)
    return []
  }

  if (typeof parsed !== 'object' || parsed === null) return []
  const hooks = (parsed as Record<string, unknown>)['hooks']
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return []

  const entries: ClaudeHookEntry[] = []

  for (const [event, matcherEntries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matcherEntries)) continue

    for (let matcherEntryIdx = 0; matcherEntryIdx < matcherEntries.length; matcherEntryIdx++) {
      const matcherEntry: unknown = matcherEntries[matcherEntryIdx]
      if (typeof matcherEntry !== 'object' || matcherEntry === null) continue

      const me = matcherEntry as Record<string, unknown>
      const matcher =
        typeof me['matcher'] === 'string' && me['matcher'].length > 0 ? me['matcher'] : null
      const hookList = me['hooks']
      if (!Array.isArray(hookList)) continue

      for (let hookIdx = 0; hookIdx < hookList.length; hookIdx++) {
        const hook: unknown = hookList[hookIdx]
        if (typeof hook !== 'object' || hook === null) continue
        const h = hook as Record<string, unknown>
        if (typeof h['command'] !== 'string' || h['command'].length === 0) continue
        const type = typeof h['type'] === 'string' ? h['type'] : 'command'

        entries.push({
          ...base,
          event,
          matcher,
          type,
          command: h['command'],
          matcherEntryIdx,
          hookIdx
        })
      }
    }
  }

  return entries
}

export function listClaudeHooks(): ClaudeHookEntry[] {
  const all: ClaudeHookEntry[] = []

  const userFilePath = nodePath.join(os.homedir(), '.claude', 'settings.json')
  all.push(...parseHooksFile(userFilePath, { source: 'user', filePath: userFilePath }))

  for (const project of listProjects()) {
    const projFilePath = nodePath.join(project.path, '.claude', 'settings.json')
    all.push(
      ...parseHooksFile(projFilePath, {
        source: 'project',
        projectId: project.id,
        projectName: project.name,
        filePath: projFilePath
      })
    )
  }

  return all.sort((a, b) => {
    // 1. user before project
    if (a.source !== b.source) return a.source === 'user' ? -1 : 1
    // 2. within project: by projectName
    if (a.source === 'project') {
      const pn = (a.projectName ?? '').localeCompare(b.projectName ?? '')
      if (pn !== 0) return pn
    }
    // 3. by event order
    const er = eventRank(a.event) - eventRank(b.event)
    if (er !== 0) return er
    // 4. by matcher — null/empty last, otherwise alpha
    const am = a.matcher ?? ''
    const bm = b.matcher ?? ''
    if (am === '' && bm !== '') return 1
    if (am !== '' && bm === '') return -1
    return am.localeCompare(bm)
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

function resolveFilePath(draft: Pick<ClaudeHookDraft, 'source' | 'projectId'>): string {
  if (draft.source === 'user') {
    return nodePath.join(os.homedir(), '.claude', 'settings.json')
  }
  if (!draft.projectId) throw new Error('projectId is required when source is "project"')
  const project = listProjects().find((p) => p.id === draft.projectId)
  if (!project) throw new Error(`Project not found: ${draft.projectId}`)
  return nodePath.join(project.path, '.claude', 'settings.json')
}

function readAndParse(filePath: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `Could not parse ${filePath} — fix it manually first.\n${(err as Error).message}`
    )
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${filePath} is not a JSON object — fix it manually first.`)
  }
  return parsed as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function addHook(draft: ClaudeHookDraft): void {
  if (!draft.command.trim()) throw new Error('command must be non-empty')
  if (!EVENT_ORDER.includes(draft.event)) {
    throw new Error(`Unknown event: ${draft.event}`)
  }

  const filePath = resolveFilePath(draft)

  // Ensure parent directory exists
  const dir = nodePath.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })

  const parsed = readAndParse(filePath)

  if (
    typeof parsed['hooks'] !== 'object' ||
    parsed['hooks'] === null ||
    Array.isArray(parsed['hooks'])
  ) {
    parsed['hooks'] = {}
  }
  const hooksObj = parsed['hooks'] as Record<string, unknown>

  if (!Array.isArray(hooksObj[draft.event])) {
    hooksObj[draft.event] = []
  }
  const eventArr = hooksObj[draft.event] as Array<Record<string, unknown>>

  const newEntry: Record<string, unknown> = {
    hooks: [{ type: draft.type || 'command', command: draft.command }]
  }
  if (draft.matcher && draft.matcher.trim().length > 0) {
    newEntry['matcher'] = draft.matcher.trim()
  }

  eventArr.push(newEntry)

  atomicWrite(filePath, JSON.stringify(parsed, null, 2))
}

export function updateHook(
  filePath: string,
  event: string,
  matcherEntryIdx: number,
  hookIdx: number,
  draft: Omit<ClaudeHookDraft, 'source' | 'projectId'>
): void {
  if (!draft.command.trim()) throw new Error('command must be non-empty')
  if (!EVENT_ORDER.includes(draft.event)) throw new Error(`Unknown event: ${draft.event}`)

  const parsed = readAndParse(filePath)

  const hooksObj = parsed['hooks']
  if (typeof hooksObj !== 'object' || hooksObj === null || Array.isArray(hooksObj)) {
    throw new Error(`hooks structure missing in ${filePath}`)
  }
  const hObj = hooksObj as Record<string, unknown>
  const eventArr = hObj[event]
  if (!Array.isArray(eventArr)) {
    throw new Error(`Event "${event}" not found in ${filePath}`)
  }
  const matcherEntry = eventArr[matcherEntryIdx] as Record<string, unknown> | undefined
  if (!matcherEntry) {
    throw new Error(`matcherEntryIdx ${matcherEntryIdx} out of range in event "${event}"`)
  }
  const hookList = matcherEntry['hooks']
  if (!Array.isArray(hookList)) {
    throw new Error(`hooks array missing at matcherEntryIdx ${matcherEntryIdx}`)
  }
  const hookItem = hookList[hookIdx] as Record<string, unknown> | undefined
  if (!hookItem) {
    throw new Error(`hookIdx ${hookIdx} out of range at matcherEntryIdx ${matcherEntryIdx}`)
  }

  // Update the hook
  hookItem['type'] = draft.type || 'command'
  hookItem['command'] = draft.command

  // Update the matcher on the parent entry
  if (draft.matcher && draft.matcher.trim().length > 0) {
    matcherEntry['matcher'] = draft.matcher.trim()
  } else {
    delete matcherEntry['matcher']
  }

  atomicWrite(filePath, JSON.stringify(parsed, null, 2))
}

export function deleteHook(
  filePath: string,
  event: string,
  matcherEntryIdx: number,
  hookIdx: number
): void {
  const parsed = readAndParse(filePath)

  const hooksObj = parsed['hooks']
  if (typeof hooksObj !== 'object' || hooksObj === null || Array.isArray(hooksObj)) {
    throw new Error(`hooks structure missing in ${filePath}`)
  }
  const hObj = hooksObj as Record<string, unknown>
  const eventArr = hObj[event]
  if (!Array.isArray(eventArr)) {
    throw new Error(`Event "${event}" not found in ${filePath}`)
  }
  const matcherEntry = eventArr[matcherEntryIdx] as Record<string, unknown> | undefined
  if (!matcherEntry) {
    throw new Error(`matcherEntryIdx ${matcherEntryIdx} out of range`)
  }
  const hookList = matcherEntry['hooks']
  if (!Array.isArray(hookList)) {
    throw new Error(`hooks array missing at matcherEntryIdx ${matcherEntryIdx}`)
  }

  // Splice the hook
  hookList.splice(hookIdx, 1)

  // If the matcher entry's hooks array is now empty, remove the matcher entry
  if (hookList.length === 0) {
    eventArr.splice(matcherEntryIdx, 1)
  }

  // If the event array is now empty, delete the event key
  if (eventArr.length === 0) {
    delete hObj[event]
  }

  // If hooks object is now empty, delete it
  if (Object.keys(hObj).length === 0) {
    delete parsed['hooks']
  }

  atomicWrite(filePath, JSON.stringify(parsed, null, 2))
}
