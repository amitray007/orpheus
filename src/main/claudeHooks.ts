import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { ClaudeHookEntry } from '../shared/types'
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
  base: Omit<ClaudeHookEntry, 'event' | 'matcher' | 'type' | 'command'>
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

    for (const matcherEntry of matcherEntries) {
      if (typeof matcherEntry !== 'object' || matcherEntry === null) continue

      const me = matcherEntry as Record<string, unknown>
      const matcher =
        typeof me['matcher'] === 'string' && me['matcher'].length > 0 ? me['matcher'] : null
      const hookList = me['hooks']
      if (!Array.isArray(hookList)) continue

      for (const hook of hookList) {
        if (typeof hook !== 'object' || hook === null) continue
        const h = hook as Record<string, unknown>
        if (typeof h['command'] !== 'string' || h['command'].length === 0) continue
        const type = typeof h['type'] === 'string' ? h['type'] : 'command'

        entries.push({ ...base, event, matcher, type, command: h['command'] })
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
