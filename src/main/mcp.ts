import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DiscoveredMcpServer } from '../shared/types'
import { listProjects } from './projects'

type ProjectContext = { projectId: string; projectName: string }

function parseMcpServers(
  parsed: unknown,
  source: 'user' | 'project',
  ctx?: ProjectContext
): DiscoveredMcpServer[] {
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

    const entry: DiscoveredMcpServer = { name, transport, command, url, source }
    if (ctx) {
      entry.projectId = ctx.projectId
      entry.projectName = ctx.projectName
    }
    result.push(entry)
  }
  return result
}

function readJsonFile(path: string): unknown | null {
  if (!fs.existsSync(path)) return null
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8'))
  } catch (err) {
    console.error('[mcp] failed to read', path, err)
    return null
  }
}

/**
 * Read MCP server definitions from ~/.claude.json (user-level) and every known
 * project's .mcp.json (project-level). Read-only — Orpheus never mutates these files.
 */
export function listMcpServers(): DiscoveredMcpServer[] {
  const all: DiscoveredMcpServer[] = []

  const userClaudeJson = nodePath.join(os.homedir(), '.claude.json')
  const userParsed = readJsonFile(userClaudeJson)
  if (userParsed) all.push(...parseMcpServers(userParsed, 'user'))

  for (const project of listProjects()) {
    const projectMcpJson = nodePath.join(project.path, '.mcp.json')
    const projectParsed = readJsonFile(projectMcpJson)
    if (!projectParsed) continue
    all.push(
      ...parseMcpServers(projectParsed, 'project', {
        projectId: project.id,
        projectName: project.name
      })
    )
  }

  // Sort: user first (group cohesion), then by project name, then by server name.
  return all.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'user' ? -1 : 1
    if (a.source === 'project') {
      const pn = (a.projectName ?? '').localeCompare(b.projectName ?? '')
      if (pn !== 0) return pn
    }
    return a.name.localeCompare(b.name)
  })
}
