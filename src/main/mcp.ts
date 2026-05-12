import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DiscoveredMcpServer } from '../shared/types'

/**
 * Read user-level MCP server definitions from ~/.claude.json.
 * This is read-only — Orpheus never modifies ~/.claude.json.
 */
export function listMcpServers(): DiscoveredMcpServer[] {
  const userClaudeJson = nodePath.join(os.homedir(), '.claude.json')
  if (!fs.existsSync(userClaudeJson)) return []

  let parsed: unknown
  try {
    const raw = fs.readFileSync(userClaudeJson, 'utf-8')
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error('[mcp] failed to read ~/.claude.json', err)
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []
  const mcpServers = (parsed as Record<string, unknown>).mcpServers
  if (!mcpServers || typeof mcpServers !== 'object') return []

  const result: DiscoveredMcpServer[] = []
  for (const [name, def] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue
    const d = def as Record<string, unknown>
    let transport: DiscoveredMcpServer['transport'] = 'unknown'
    let command: string | undefined
    let url: string | undefined

    if (typeof d.url === 'string') {
      url = d.url
      transport = d.transport === 'sse' ? 'sse' : 'http'
    } else if (typeof d.command === 'string') {
      command = d.command
      transport = 'stdio'
    }

    result.push({ name, transport, command, url, source: 'user' })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}
