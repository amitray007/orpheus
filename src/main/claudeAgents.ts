import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type {
  ClaudeSlashCommand,
  ClaudeSubagent,
  ClaudeSlashCommandDraft,
  ClaudeSubagentDraft
} from '../shared/types'
import { listProjects } from './projects'

const SLUG_RE = /^[a-z0-9_-]+$/

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

// Minimal frontmatter parser — handles only the subset Claude command/agent
// files actually use: scalar strings, inline flow sequences [a, b], and block
// sequences (  - item). No block scalars, anchors, or nested objects.
function parseFrontmatter(content: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  const lines = content.split('\n')

  if (lines[0]?.trim() !== '---') return result

  let i = 1
  while (i < lines.length && lines[i]?.trim() !== '---') {
    const line = lines[i]
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      i++
      continue
    }

    const key = line.slice(0, colonIdx).trim()
    const rest = line.slice(colonIdx + 1)

    // Check if next lines form a block sequence (  - item)
    if (rest.trim() === '') {
      const items: string[] = []
      let j = i + 1
      while (j < lines.length && /^ {2}- /.test(lines[j])) {
        items.push(lines[j].replace(/^ {2}- /, '').trim())
        j++
      }
      if (items.length > 0) {
        result[key] = items
        i = j
        continue
      }
    }

    const value = rest.trim()

    // Inline flow sequence: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1)
      result[key] = inner.split(',').flatMap((s) => {
        const v = s.trim()
        return v ? [v] : []
      })
      i++
      continue
    }

    // Scalar — strip surrounding quotes if present
    result[key] = value.replace(/^(['"])(.*)\1$/, '$2')
    i++
  }

  return result
}

// ---------------------------------------------------------------------------
// Frontmatter serialization (inverse of parseFrontmatter)
// ---------------------------------------------------------------------------

function serializeFrontmatter(
  record: Record<string, string | string[] | null | undefined>
): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      // Inline flow for short lists (<=5 items), block for longer
      if (value.length <= 5) {
        lines.push(`${key}: [${value.join(', ')}]`)
      } else {
        lines.push(`${key}:`)
        for (const item of value) {
          lines.push(`  - ${item}`)
        }
      }
    } else {
      if (value === '') continue
      // Quote if contains colon or hash or starts with whitespace
      const needsQuotes = value.includes(':') || value.includes('#') || /^\s/.test(value)
      const serialized = needsQuotes
        ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        : value
      lines.push(`${key}: ${serialized}`)
    }
  }
  return lines.join('\n')
}

function buildMdFile(
  frontmatter: Record<string, string | string[] | null | undefined>,
  body: string
): string {
  const fm = serializeFrontmatter(frontmatter)
  if (fm) {
    return `---\n${fm}\n---\n${body}\n`
  }
  return body + '\n'
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, filePath)
}

function parseFile(filePath: string): {
  frontmatter: Record<string, string | string[]>
  bodyPreview: string
} {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const frontmatter = parseFrontmatter(content)

    // Body = content after the closing --- line (the second --- in the file)
    const lines = content.split('\n')
    let closingIdx = -1
    if (lines[0]?.trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === '---') {
          closingIdx = i
          break
        }
      }
    }

    let bodyPreview = ''
    if (closingIdx !== -1) {
      const raw = lines
        .slice(closingIdx + 1)
        .join('\n')
        .trim()
      if (raw.length > 600) {
        bodyPreview = raw.slice(0, 600) + '\n…'
      } else {
        bodyPreview = raw
      }
    }

    return { frontmatter, bodyPreview }
  } catch {
    return { frontmatter: {}, bodyPreview: '' }
  }
}

function listMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')
          ? [nodePath.join(dir, e.name)]
          : []
      )
      .sort((a, b) => nodePath.basename(a).localeCompare(nodePath.basename(b)))
  } catch {
    return []
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function stringsOrNull(v: unknown): string[] | null {
  if (Array.isArray(v)) {
    const strs = v.filter((s): s is string => typeof s === 'string' && s.length > 0)
    return strs.length > 0 ? strs : null
  }
  if (typeof v === 'string' && v.length > 0) {
    // Single unquoted value that wasn't wrapped in brackets
    return [v]
  }
  return null
}

// ---------------------------------------------------------------------------
// List functions
// ---------------------------------------------------------------------------

export function listSlashCommands(): ClaudeSlashCommand[] {
  const all: ClaudeSlashCommand[] = []

  const userDir = nodePath.join(os.homedir(), '.claude', 'commands')
  for (const filePath of listMdFiles(userDir)) {
    const { frontmatter: fm, bodyPreview } = parseFile(filePath)
    const baseName = nodePath.basename(filePath, '.md')
    all.push({
      name: stringOrNull(fm['name']) ?? baseName,
      path: filePath,
      source: 'user',
      description: stringOrNull(fm['description']),
      allowedTools: stringsOrNull(fm['allowed-tools']),
      argumentHint: stringOrNull(fm['argument-hint']),
      frontmatter: fm,
      bodyPreview
    })
  }

  for (const project of listProjects()) {
    const projectDir = nodePath.join(project.path, '.claude', 'commands')
    for (const filePath of listMdFiles(projectDir)) {
      const { frontmatter: fm, bodyPreview } = parseFile(filePath)
      const baseName = nodePath.basename(filePath, '.md')
      all.push({
        name: stringOrNull(fm['name']) ?? baseName,
        path: filePath,
        source: 'project',
        projectId: project.id,
        projectName: project.name,
        description: stringOrNull(fm['description']),
        allowedTools: stringsOrNull(fm['allowed-tools']),
        argumentHint: stringOrNull(fm['argument-hint']),
        frontmatter: fm,
        bodyPreview
      })
    }
  }

  return all.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'user' ? -1 : 1
    if (a.source === 'project') {
      const pn = (a.projectName ?? '').localeCompare(b.projectName ?? '')
      if (pn !== 0) return pn
    }
    return a.name.localeCompare(b.name)
  })
}

export function listSubagents(): ClaudeSubagent[] {
  const all: ClaudeSubagent[] = []

  const userDir = nodePath.join(os.homedir(), '.claude', 'agents')
  for (const filePath of listMdFiles(userDir)) {
    const { frontmatter: fm, bodyPreview } = parseFile(filePath)
    const baseName = nodePath.basename(filePath, '.md')
    all.push({
      name: stringOrNull(fm['name']) ?? baseName,
      path: filePath,
      source: 'user',
      description: stringOrNull(fm['description']),
      tools: stringsOrNull(fm['tools']),
      model: stringOrNull(fm['model']),
      frontmatter: fm,
      bodyPreview
    })
  }

  for (const project of listProjects()) {
    const projectDir = nodePath.join(project.path, '.claude', 'agents')
    for (const filePath of listMdFiles(projectDir)) {
      const { frontmatter: fm, bodyPreview } = parseFile(filePath)
      const baseName = nodePath.basename(filePath, '.md')
      all.push({
        name: stringOrNull(fm['name']) ?? baseName,
        path: filePath,
        source: 'project',
        projectId: project.id,
        projectName: project.name,
        description: stringOrNull(fm['description']),
        tools: stringsOrNull(fm['tools']),
        model: stringOrNull(fm['model']),
        frontmatter: fm,
        bodyPreview
      })
    }
  }

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
// Slash command mutations
// ---------------------------------------------------------------------------

function resolveCommandDir(draft: Pick<ClaudeSlashCommandDraft, 'source' | 'projectId'>): string {
  if (draft.source === 'user') {
    return nodePath.join(os.homedir(), '.claude', 'commands')
  }
  if (!draft.projectId) throw new Error('projectId is required when source is "project"')
  const project = listProjects().find((p) => p.id === draft.projectId)
  if (!project) throw new Error(`Project not found: ${draft.projectId}`)
  return nodePath.join(project.path, '.claude', 'commands')
}

function validateSlashCommandName(name: string): void {
  if (!SLUG_RE.test(name)) {
    throw new Error(
      `Command name "${name}" is invalid. Use only lowercase letters, digits, underscores, and hyphens.`
    )
  }
}

export function addSlashCommand(draft: ClaudeSlashCommandDraft): void {
  validateSlashCommandName(draft.name)
  if (!draft.body.trim()) throw new Error('Body cannot be empty.')

  const dir = resolveCommandDir(draft)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = nodePath.join(dir, `${draft.name}.md`)

  if (fs.existsSync(filePath)) {
    throw new Error(`A command named "${draft.name}" already exists.`)
  }

  const content = buildMdFile(
    {
      description: draft.description || null,
      'allowed-tools':
        draft.allowedTools && draft.allowedTools.length > 0 ? draft.allowedTools : null,
      'argument-hint': draft.argumentHint || null
    },
    draft.body
  )
  atomicWrite(filePath, content)
}

export function updateSlashCommand(
  filePath: string,
  draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'>
): void {
  validateSlashCommandName(draft.name)
  if (!draft.body.trim()) throw new Error('Body cannot be empty.')

  // Reject renames (name must match existing basename)
  const existingBase = nodePath.basename(filePath, '.md')
  if (draft.name !== existingBase) {
    throw new Error(
      `Renaming a command is not supported. To rename, delete "${existingBase}" and create a new command named "${draft.name}".`
    )
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const content = buildMdFile(
    {
      description: draft.description || null,
      'allowed-tools':
        draft.allowedTools && draft.allowedTools.length > 0 ? draft.allowedTools : null,
      'argument-hint': draft.argumentHint || null
    },
    draft.body
  )
  atomicWrite(filePath, content)
}

export function deleteSlashCommand(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  fs.unlinkSync(filePath)
}

// ---------------------------------------------------------------------------
// Subagent mutations
// ---------------------------------------------------------------------------

function resolveAgentDir(draft: Pick<ClaudeSubagentDraft, 'source' | 'projectId'>): string {
  if (draft.source === 'user') {
    return nodePath.join(os.homedir(), '.claude', 'agents')
  }
  if (!draft.projectId) throw new Error('projectId is required when source is "project"')
  const project = listProjects().find((p) => p.id === draft.projectId)
  if (!project) throw new Error(`Project not found: ${draft.projectId}`)
  return nodePath.join(project.path, '.claude', 'agents')
}

function validateSubagentName(name: string): void {
  if (!SLUG_RE.test(name)) {
    throw new Error(
      `Subagent name "${name}" is invalid. Use only lowercase letters, digits, underscores, and hyphens.`
    )
  }
}

export function addSubagent(draft: ClaudeSubagentDraft): void {
  validateSubagentName(draft.name)
  if (!draft.body.trim()) throw new Error('Body cannot be empty.')

  const dir = resolveAgentDir(draft)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = nodePath.join(dir, `${draft.name}.md`)

  if (fs.existsSync(filePath)) {
    throw new Error(`A subagent named "${draft.name}" already exists.`)
  }

  const content = buildMdFile(
    {
      description: draft.description || null,
      tools: draft.tools && draft.tools.length > 0 ? draft.tools : null,
      model: draft.model || null
    },
    draft.body
  )
  atomicWrite(filePath, content)
}

export function updateSubagent(
  filePath: string,
  draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'>
): void {
  validateSubagentName(draft.name)
  if (!draft.body.trim()) throw new Error('Body cannot be empty.')

  // Reject renames
  const existingBase = nodePath.basename(filePath, '.md')
  if (draft.name !== existingBase) {
    throw new Error(
      `Renaming a subagent is not supported. To rename, delete "${existingBase}" and create a new subagent named "${draft.name}".`
    )
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const content = buildMdFile(
    {
      description: draft.description || null,
      tools: draft.tools && draft.tools.length > 0 ? draft.tools : null,
      model: draft.model || null
    },
    draft.body
  )
  atomicWrite(filePath, content)
}

export function deleteSubagent(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }
  fs.unlinkSync(filePath)
}
