import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { parse, parseDocument } from 'yaml'
import { resolveMainWorktree, NotAGitRepoError } from './worktrees'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspacesConfig = { allowLocal: boolean; allowWorktree: boolean }
export type OfferedModes = { local: boolean; worktree: boolean; reason?: string }

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const configNotices: string[] = []
const selfWrites = new Set<string>()

// Repeated path segments for the per-project/global config file — hoisted
// since '.orpheus' and 'config.yml' each show up across path.join/resolve
// calls and fs.watch filename checks below.
const ORPHEUS_DIR_NAME = '.orpheus'
const CONFIG_FILE_NAME = 'config.yml'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TEMPLATE = `# Orpheus workspace-creation settings for this project.
# Remove or set to true to re-enable a disabled option.
workspaces:
  # Allow creating "Local" (non-worktree) workspaces.
  allowLocal: true
  # Allow creating "Worktree" workspaces (requires Git).
  allowWorktree: true
`

function parseWorkspacesBlock(raw: unknown): {
  value: Partial<WorkspacesConfig>
  notices: string[]
} {
  const notices: string[] = []
  const value: Partial<WorkspacesConfig> = {}

  if (!raw || typeof raw !== 'object') return { value, notices }

  const block = raw as Record<string, unknown>

  for (const key of ['allowLocal', 'allowWorktree'] as const) {
    if (key in block) {
      if (typeof block[key] === 'boolean') {
        value[key] = block[key]
      } else {
        notices.push(`.orpheus/config.yml: workspaces.${key} must be true/false — ignoring`)
      }
    }
  }

  return { value, notices }
}

async function readYamlFile(filePath: string): Promise<unknown> {
  let text: string
  try {
    text = await fs.promises.readFile(filePath, 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parse(text)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function consumeConfigNotices(): string[] {
  return configNotices.splice(0)
}

export async function resolveWorkspacesConfig(projectCwd: string): Promise<WorkspacesConfig> {
  const defaults: WorkspacesConfig = { allowLocal: true, allowWorktree: true }

  const globalPath = path.join(os.homedir(), ORPHEUS_DIR_NAME, CONFIG_FILE_NAME)
  const projectPath = path.join(projectCwd, ORPHEUS_DIR_NAME, CONFIG_FILE_NAME)

  let merged: WorkspacesConfig = { ...defaults }

  for (const filePath of [globalPath, projectPath]) {
    let parsed: unknown
    try {
      parsed = await readYamlFile(filePath)
    } catch {
      configNotices.push(`.orpheus/config.yml: failed to parse ${filePath} — ignoring`)
      continue
    }
    if (parsed === null) continue

    const block =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)['workspaces']
        : undefined

    if (block !== undefined) {
      const { value, notices } = parseWorkspacesBlock(block)
      configNotices.push(...notices)
      merged = { ...merged, ...value }
    }
  }

  return merged
}

export async function resolveOfferedModes(
  projectCwd: string,
  isGitRepo: boolean
): Promise<OfferedModes> {
  const { allowLocal, allowWorktree } = await resolveWorkspacesConfig(projectCwd)

  if (!isGitRepo) {
    return { local: true, worktree: false }
  }

  if (!allowLocal && !allowWorktree) {
    configNotices.push(
      `.orpheus/config.yml: both allowLocal and allowWorktree are false — ignoring, defaulting to local only`
    )
    return { local: true, worktree: false, reason: 'config-invalid-both-disabled' }
  }

  return { local: allowLocal, worktree: allowWorktree }
}

/**
 * Is-git-repo detection + resolveOfferedModes, bundled into one call so
 * every caller (renderer IPC via app:offeredModes, the command socket via
 * project.offeredModes) computes "is this a git repo" the SAME way and can
 * never drift apart. Originally inlined in the app:offeredModes IPC handler
 * (src/main/ipc/misc.ts); extracted here so the command-socket action can
 * reuse it verbatim rather than re-implementing the ENOENT/NotAGitRepoError
 * handling — a second copy would risk the TUI offering a mode (e.g.
 * 'worktree') that the backend then refuses because its own git-repo check
 * disagreed with the renderer's.
 *
 * resolveMainWorktree throws NotAGitRepoError for a non-git cwd, which is
 * caught and narrowed to `isGitRepo: false`; any other error propagates.
 */
export async function resolveOfferedModesForProject(projectCwd: string): Promise<OfferedModes> {
  let isGitRepo = true
  try {
    await resolveMainWorktree(projectCwd)
  } catch (err) {
    if (err instanceof NotAGitRepoError) {
      isGitRepo = false
    } else {
      throw err
    }
  }

  return resolveOfferedModes(projectCwd, isGitRepo)
}

export async function writeProjectOverride(
  projectCwd: string,
  patch: Partial<WorkspacesConfig>
): Promise<void> {
  const configPath = path.join(projectCwd, ORPHEUS_DIR_NAME, CONFIG_FILE_NAME)
  const dir = path.dirname(configPath)

  await fs.promises.mkdir(dir, { recursive: true })

  let docText: string
  try {
    docText = await fs.promises.readFile(configPath, 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      docText = ''
    } else {
      throw err
    }
  }

  const doc = (() => {
    if (!docText) return parseDocument(TEMPLATE)
    const parsed = parseDocument(docText)
    if (parsed.errors.length > 0) return parseDocument(TEMPLATE)
    return parsed
  })()

  for (const [key, value] of Object.entries(patch) as [keyof WorkspacesConfig, boolean][]) {
    doc.setIn(['workspaces', key], value)
  }

  const output = doc.toString()
  const tmpPath = `${configPath}.tmp`
  const resolvedPath = path.resolve(configPath)

  selfWrites.add(resolvedPath)
  await fs.promises.writeFile(tmpPath, output, 'utf8')
  await fs.promises.rename(tmpPath, configPath)
  setTimeout(() => selfWrites.delete(resolvedPath), 500)
}

export function watchOrpheusConfig(projectCwd: string | null, onChange: () => void): () => void {
  const globalDir = path.join(os.homedir(), ORPHEUS_DIR_NAME)
  const watchers: fs.FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function handleEvent(dir: string, filename: string | null): void {
    if (filename !== CONFIG_FILE_NAME) return

    const resolved = path.resolve(dir, CONFIG_FILE_NAME)
    if (selfWrites.has(resolved)) {
      selfWrites.delete(resolved)
      return
    }

    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      onChange()
    }, 150)
  }

  try {
    const w = fs.watch(globalDir, (_, filename) => handleEvent(globalDir, filename))
    watchers.push(w)
  } catch {
    // dir doesn't exist yet — skip
  }

  if (projectCwd) {
    const projectDir = path.join(projectCwd, ORPHEUS_DIR_NAME)
    try {
      const w = fs.watch(projectDir, (_, filename) => handleEvent(projectDir, filename))
      watchers.push(w)
    } catch {
      // dir doesn't exist yet — skip
    }
  }

  return () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    for (const w of watchers) w.close()
  }
}
