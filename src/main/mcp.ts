import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DiscoveredMcpServer, McpServerDraft } from '../shared/types'
import { listProjects } from './projects'

const NAME_RE = /^[a-z0-9_-]+$/i

type ProjectContext = { projectId: string; projectName: string }

function parseMcpServers(
  parsed: unknown,
  source: 'user' | 'project',
  filePath: string,
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
    let args: string[] | undefined
    let env: Record<string, string> | undefined
    let url: string | undefined

    if (typeof d.url === 'string') {
      url = d.url
      transport = d.transport === 'sse' ? 'sse' : 'http'
    } else if (typeof d.command === 'string') {
      command = d.command
      transport = 'stdio'
    }

    if (Array.isArray(d.args)) {
      args = d.args.filter((a): a is string => typeof a === 'string')
    }
    if (d.env && typeof d.env === 'object' && !Array.isArray(d.env)) {
      env = {}
      for (const [k, v] of Object.entries(d.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v
      }
    }

    const entry: DiscoveredMcpServer = { name, transport, command, args, env, url, source, filePath }
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
 * project's .mcp.json (project-level).
 */
export function listMcpServers(): DiscoveredMcpServer[] {
  const all: DiscoveredMcpServer[] = []

  const userClaudeJson = nodePath.join(os.homedir(), '.claude.json')
  const userParsed = readJsonFile(userClaudeJson)
  if (userParsed) all.push(...parseMcpServers(userParsed, 'user', userClaudeJson))

  for (const project of listProjects()) {
    const projectMcpJson = nodePath.join(project.path, '.mcp.json')
    const projectParsed = readJsonFile(projectMcpJson)
    if (!projectParsed) continue
    all.push(
      ...parseMcpServers(projectParsed, 'project', projectMcpJson, {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

function resolveFilePath(draft: Pick<McpServerDraft, 'source' | 'projectId'>): string {
  if (draft.source === 'user') {
    return nodePath.join(os.homedir(), '.claude.json')
  }
  if (!draft.projectId) throw new Error('projectId is required when source is "project"')
  const project = listProjects().find((p) => p.id === draft.projectId)
  if (!project) throw new Error(`Project not found: ${draft.projectId}`)
  return nodePath.join(project.path, '.mcp.json')
}

function readAndParseUserFile(filePath: string): Record<string, unknown> {
  // ~/.claude.json must already exist and be valid JSON; abort on parse failure
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new Error(
        `${filePath} does not exist. Create it first (e.g. run claude once to generate it).`
      )
    }
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object — fix it manually first.`)
  }
  return parsed as Record<string, unknown>
}

function readAndParseProjectFile(filePath: string): Record<string, unknown> {
  // Per-project .mcp.json: create empty if missing, abort on parse failure
  if (!fs.existsSync(filePath)) return {}
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object — fix it manually first.`)
  }
  return parsed as Record<string, unknown>
}

function validateDraft(draft: McpServerDraft): void {
  if (!NAME_RE.test(draft.name)) {
    throw new Error(
      `Server name "${draft.name}" is invalid. Only letters, digits, underscores, and hyphens are allowed (no spaces or slashes).`
    )
  }
  if (!['stdio', 'http', 'sse'].includes(draft.transport)) {
    throw new Error(`Invalid transport "${draft.transport}". Must be stdio, http, or sse.`)
  }
  if (draft.transport === 'stdio' && !draft.command?.trim()) {
    throw new Error('Command is required for stdio transport.')
  }
  if ((draft.transport === 'http' || draft.transport === 'sse') && !draft.url?.trim()) {
    throw new Error(`URL is required for ${draft.transport} transport.`)
  }
}

function buildServerDef(draft: Omit<McpServerDraft, 'source' | 'projectId'>): Record<string, unknown> {
  const def: Record<string, unknown> = {}
  if (draft.transport === 'stdio') {
    def.command = draft.command!.trim()
    if (draft.args && draft.args.length > 0) def.args = draft.args
    if (draft.env && Object.keys(draft.env).length > 0) def.env = draft.env
  } else {
    def.type = draft.transport
    def.url = draft.url!.trim()
  }
  return def
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function addMcpServer(draft: McpServerDraft): void {
  validateDraft(draft)

  const filePath = resolveFilePath(draft)

  if (draft.source === 'project') {
    const dir = nodePath.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const parsed = readAndParseProjectFile(filePath)
    if (typeof parsed['mcpServers'] !== 'object' || parsed['mcpServers'] === null || Array.isArray(parsed['mcpServers'])) {
      parsed['mcpServers'] = {}
    }
    const servers = parsed['mcpServers'] as Record<string, unknown>
    if (servers[draft.name]) {
      throw new Error(`A server named "${draft.name}" already exists.`)
    }
    servers[draft.name] = buildServerDef(draft)
    atomicWrite(filePath, JSON.stringify(parsed, null, 2))
  } else {
    // user source — touch only mcpServers key, preserve everything else
    const parsed = readAndParseUserFile(filePath)
    if (typeof parsed['mcpServers'] !== 'object' || parsed['mcpServers'] === null || Array.isArray(parsed['mcpServers'])) {
      parsed['mcpServers'] = {}
    }
    const servers = parsed['mcpServers'] as Record<string, unknown>
    if (servers[draft.name]) {
      throw new Error(`A server named "${draft.name}" already exists.`)
    }
    servers[draft.name] = buildServerDef(draft)
    atomicWrite(filePath, JSON.stringify(parsed, null, 2))
  }
}

export function updateMcpServer(
  filePath: string,
  oldName: string,
  draft: Omit<McpServerDraft, 'source' | 'projectId'>
): void {
  validateDraft({ ...draft, source: 'user' })  // source not used for validation

  const isUserFile = filePath === nodePath.join(os.homedir(), '.claude.json')
  const parsed = isUserFile ? readAndParseUserFile(filePath) : readAndParseProjectFile(filePath)

  if (typeof parsed['mcpServers'] !== 'object' || parsed['mcpServers'] === null || Array.isArray(parsed['mcpServers'])) {
    throw new Error(`mcpServers missing in ${filePath}`)
  }
  const servers = parsed['mcpServers'] as Record<string, unknown>
  if (!(oldName in servers)) {
    throw new Error(`Server "${oldName}" not found in ${filePath}`)
  }

  // Handle rename: remove old key, add new key
  if (draft.name !== oldName) {
    if (servers[draft.name]) {
      throw new Error(`A server named "${draft.name}" already exists.`)
    }
    delete servers[oldName]
  }
  servers[draft.name] = buildServerDef(draft)

  atomicWrite(filePath, JSON.stringify(parsed, null, 2))
}

export function deleteMcpServer(filePath: string, name: string): void {
  const isUserFile = filePath === nodePath.join(os.homedir(), '.claude.json')
  const parsed = isUserFile ? readAndParseUserFile(filePath) : readAndParseProjectFile(filePath)

  if (typeof parsed['mcpServers'] !== 'object' || parsed['mcpServers'] === null || Array.isArray(parsed['mcpServers'])) {
    throw new Error(`mcpServers missing in ${filePath}`)
  }
  const servers = parsed['mcpServers'] as Record<string, unknown>
  if (!(name in servers)) {
    throw new Error(`Server "${name}" not found in ${filePath}`)
  }
  delete servers[name]

  atomicWrite(filePath, JSON.stringify(parsed, null, 2))
}
