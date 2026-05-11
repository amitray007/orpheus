export type ExistingProject = {
  encodedName: string // e.g. "-Users-maverick-code-projects-orpheus"
  path: string // decoded absolute path, e.g. "/Users/maverick/code/projects/orpheus"
  name: string // basename, e.g. "orpheus"
  sessionCount: number // number of .jsonl files inside the dir
  lastActivity: number | null // ms timestamp of most recent .jsonl mtime, or null
}

export type DoctorResult = {
  claudeInstalled: boolean
  claudeVersion: string | null // e.g. "1.2.3" extracted from `claude --version`
  claudePath: string | null // e.g. "/usr/local/bin/claude"
  existingProjects: ExistingProject[]
}

// ---------------------------------------------------------------------------
// Persistence types (SQLite-backed)
// ---------------------------------------------------------------------------

export type ProjectRecord = {
  id: string
  path: string
  name: string
  claudeEncodedName: string | null
  addedAt: number
  lastOpenedAt: number | null
  archivedAt: number | null
  pinnedAt: number | null
}

export type WorkspaceRecord = {
  id: string
  projectId: string
  name: string
  cwd: string
  pinnedAt: number | null
  createdAt: number
  lastOpenedAt: number | null
  archivedAt: number | null
}

// For Pinned section: a pinned project, or a pinned workspace with its project's context for breadcrumb display
export type PinnedItem =
  | { kind: 'project'; project: ProjectRecord }
  | { kind: 'workspace'; workspace: WorkspaceRecord; project: ProjectRecord }

export type SessionStatus = 'in_progress' | 'in_review' | 'archived'

export type SessionRecord = {
  id: string
  projectId: string
  jsonlPath: string
  title: string | null
  status: SessionStatus
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  model: string | null
  lastMessageRole: string | null
}
