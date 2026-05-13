import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { ClaudeSlashCommand, ClaudeSubagent } from '../shared/types'
import { listProjects } from './projects'

// Minimal frontmatter parser — handles only the subset Claude command/agent
// files actually use: scalar strings, inline flow sequences [a, b], and block
// sequences (  - item). No block scalars, anchors, or nested objects.
function parseFrontmatter(content: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  const lines = content.split('\n')

  if (lines[0]?.trim() !== '---') return result

  let i = 1
  while (i < lines.length && lines[i]?.trim() !== '---') {
    const line = lines[i]!
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) { i++; continue }

    const key = line.slice(0, colonIdx).trim()
    const rest = line.slice(colonIdx + 1)

    // Check if next lines form a block sequence (  - item)
    if (rest.trim() === '') {
      const items: string[] = []
      let j = i + 1
      while (j < lines.length && /^ {2}- /.test(lines[j]!)) {
        items.push(lines[j]!.replace(/^ {2}- /, '').trim())
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
      result[key] = inner.split(',').map((s) => s.trim()).filter(Boolean)
      i++
      continue
    }

    // Scalar — strip surrounding quotes if present
    result[key] = value.replace(/^(['"])(.*)\1$/, '$2')
    i++
  }

  return result
}

function parseFile(filePath: string): { frontmatter: Record<string, string | string[]>; bodyPreview: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const frontmatter = parseFrontmatter(content)

    // Body = content after the closing --- line (the second --- in the file)
    const lines = content.split('\n')
    let closingIdx = -1
    if (lines[0]?.trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === '---') { closingIdx = i; break }
      }
    }

    let bodyPreview = ''
    if (closingIdx !== -1) {
      const raw = lines.slice(closingIdx + 1).join('\n').trim()
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
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
      .map((e) => nodePath.join(dir, e.name))
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
