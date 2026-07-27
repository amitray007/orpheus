import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalReviewComment, ProjectRecord, WorkspaceRecord } from '../src/shared/types.ts'
import { createMainReadHandlers } from '../src/main/controlPlane/mainReadHandlers.ts'
import {
  MAX_TRANSCRIPT_BYTES,
  observeTranscriptFile
} from '../src/main/controlPlane/transcriptObservation.ts'
import type { ControlContext, TrustedRuntimeBinding } from '../src/main/controlPlane/types.ts'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-read-adapters-'))
const transcriptPath = path.join(tempDir, 'session.jsonl')
const emptyPath = path.join(tempDir, 'empty.jsonl')
const boundedPath = path.join(tempDir, 'bounded.jsonl')
const observedAt = 1_800_000_000_000

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

fs.writeFileSync(
  transcriptPath,
  [
    line({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'old user' }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-01-01T00:01:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'old assistant' },
          { type: 'tool_use', name: 'Read', input: { secret: 'must-not-leak' } }
        ]
      }
    }),
    '{malformed-json\n',
    line({
      type: 'user',
      timestamp: '2026-01-01T00:02:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'new user' },
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'TOOL_RESULT_SECRET_SENTINEL'
          }
        ]
      }
    }),
    line({
      type: 'assistant',
      timestamp: '2026-01-01T00:03:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'new assistant' },
          { type: 'tool_use', name: 'Bash', input: { command: 'private command' } }
        ]
      }
    })
  ].join('')
)
fs.writeFileSync(emptyPath, '')

const unfiltered = await observeTranscriptFile(transcriptPath, {
  limit: 100,
  includeToolActivity: true,
  observedAt
})
assert.equal(unfiltered.transcript.availability, 'available')
assert.equal(unfiltered.transcript.observedAt, observedAt)
assert.ok((unfiltered.transcript.sourceUpdatedAt ?? 0) > 0)
assert.equal(unfiltered.transcript.value?.turns.length, 4)
assert.equal(unfiltered.transcript.value?.truncated, true)
assert.ok((unfiltered.transcript.value?.bytesRead ?? 0) <= MAX_TRANSCRIPT_BYTES)
assert.deepEqual(unfiltered.lastTurn.value, {
  userText: 'new user',
  assistantText: 'new assistant',
  userAt: Date.parse('2026-01-01T00:02:00.000Z'),
  assistantAt: Date.parse('2026-01-01T00:03:00.000Z')
})
const assistantTools = unfiltered.transcript.value?.turns.at(-1)?.toolActivity
assert.deepEqual(assistantTools, [{ kind: 'tool_use', name: 'Bash', summary: 'Used Bash' }])
assert.doesNotMatch(
  JSON.stringify(unfiltered.transcript.value),
  /private command|must-not-leak|TOOL_RESULT_SECRET_SENTINEL/
)
assert.deepEqual(unfiltered.transcript.value?.turns.at(-2)?.toolActivity, [
  { kind: 'tool_result', summary: 'Tool returned a result' }
])

const filtered = await observeTranscriptFile(transcriptPath, {
  limit: 1,
  role: 'assistant',
  since: Date.parse('2026-01-01T00:02:30.000Z'),
  includeToolActivity: false,
  observedAt
})
assert.deepEqual(filtered.transcript.value?.turns, [
  {
    role: 'assistant',
    text: 'new assistant',
    timestamp: Date.parse('2026-01-01T00:03:00.000Z')
  }
])

const moreThanOneHundred = Array.from({ length: 120 }, (_, index) =>
  line({
    type: 'assistant',
    timestamp: `2026-01-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    message: { role: 'assistant', content: `turn-${index}` }
  })
).join('')
fs.writeFileSync(boundedPath, `${'x'.repeat(2_000)}\n${moreThanOneHundred}`)
const bounded = await observeTranscriptFile(boundedPath, {
  limit: 1_000,
  maxBytes: 1_024,
  observedAt
})
assert.equal(bounded.transcript.value?.truncated, true)
assert.ok((bounded.transcript.value?.bytesRead ?? 0) <= 1_024)
assert.ok((bounded.transcript.value?.turns.length ?? 0) <= 100)
assert.equal(bounded.transcript.value?.turns.at(-1)?.text, 'turn-119')

const missing = await observeTranscriptFile(path.join(tempDir, 'missing.jsonl'), {
  observedAt
})
assert.equal(missing.transcript.availability, 'unavailable')
assert.equal(missing.transcript.value, null)
assert.match(missing.transcript.reason ?? '', /does not exist/)

const empty = await observeTranscriptFile(emptyPath, { observedAt })
assert.equal(empty.transcript.availability, 'available')
assert.deepEqual(empty.transcript.value?.turns, [])
assert.deepEqual(empty.lastTurn.value, {
  userText: null,
  assistantText: null,
  userAt: null,
  assistantAt: null
})

const project: ProjectRecord = {
  id: 'project-1',
  path: '/private/project',
  name: 'Project',
  claudeEncodedName: '-private-project',
  addedAt: 10,
  lastOpenedAt: 20,
  expandedInSidebar: true,
  sortOrder: 7,
  pinnedAt: null,
  githubOwner: 'secret-owner',
  githubRepo: 'secret-repo',
  githubAvatarUrl: 'https://secret.invalid/avatar',
  githubCheckedAt: 99,
  classified: true,
  hidden: false
}
const otherProject: ProjectRecord = { ...project, id: 'project-2', name: 'Other' }
const workspace: WorkspaceRecord = {
  id: 'workspace-1',
  projectId: project.id,
  name: 'Workspace',
  nameIsAuto: true,
  cwd: project.path,
  pinnedAt: null,
  createdAt: 30,
  lastOpenedAt: 40,
  archivedAt: null,
  closedAt: null,
  sortOrder: 8,
  status: 'idle',
  claudeSessionId: 'session-1',
  forkedFromSessionId: 'secret-fork',
  lastTitle: 'secret title',
  parentWorkspaceId: null,
  worktreeParentCwd: null,
  worktreeBranch: null
}
const otherWorkspace: WorkspaceRecord = {
  ...workspace,
  id: 'workspace-2',
  projectId: otherProject.id
}
const review: LocalReviewComment = {
  id: 'review-1',
  workspaceId: workspace.id,
  prNumber: null,
  path: 'src/file.ts',
  line: 4,
  startLine: null,
  side: 'RIGHT',
  body: 'Review this.',
  author: 'you',
  resolved: false,
  createdAt: 50,
  updatedAt: 50
}

const handlers = createMainReadHandlers({
  listProjects: () => [project, otherProject],
  getProject: (id) => (id === project.id ? project : null),
  listWorkspacesForProject: () => [workspace, otherWorkspace],
  getWorkspace: (id) => (id === workspace.id ? workspace : null),
  listReviewsByWorkspace: () => [review],
  transcriptPathForWorkspace: () => transcriptPath,
  statusObservation: (workspaceId, now) => ({
    value: {
      persistedStatus: workspace.status,
      liveStatus: 'waiting',
      waitingFor: `input for ${workspaceId}`
    },
    source: 'claude-session-file',
    observedAt: now,
    sourceUpdatedAt: now - 1,
    availability: 'available',
    stale: false
  }),
  now: () => observedAt
})

const projectList = await handlers.listProjects(project.id, {} as ControlContext)
assert.deepEqual(projectList.value, [
  {
    id: project.id,
    name: project.name,
    path: project.path,
    addedAt: project.addedAt,
    lastOpenedAt: project.lastOpenedAt,
    pinnedAt: project.pinnedAt,
    classified: project.classified,
    hidden: project.hidden
  }
])
assert.doesNotMatch(JSON.stringify(projectList.value), /github|secret-owner|sortOrder/)
const missingProject = await handlers.getProject('missing-project', {} as ControlContext)
assert.equal(missingProject.value, null)
assert.equal(missingProject.availability, 'unavailable')
assert.equal(missingProject.stale, null)

const workspaceList = await handlers.listWorkspaces(project.id, 'all', {} as ControlContext)
assert.equal(workspaceList.value?.length, 1)
assert.deepEqual(Object.keys(workspaceList.value?.[0] ?? {}).sort(), [
  'archivedAt',
  'claudeConversationId',
  'closedAt',
  'createdAt',
  'cwd',
  'id',
  'lastOpenedAt',
  'name',
  'parentWorkspaceId',
  'pinnedAt',
  'projectId',
  'status',
  'worktreeBranch',
  'worktreeParentCwd'
])
assert.doesNotMatch(JSON.stringify(workspaceList.value), /secret-fork|secret title|sortOrder/)
const missingWorkspace = await handlers.getWorkspace('missing-workspace', {} as ControlContext)
assert.equal(missingWorkspace.value, null)
assert.equal(missingWorkspace.availability, 'unavailable')

const binding: TrustedRuntimeBinding = {
  runtimeId: 'runtime-1',
  runtimeKind: 'claude',
  surfaceId: 'surface-1',
  workspaceId: workspace.id,
  projectId: project.id,
  claudeConversationId: workspace.claudeSessionId,
  issuedAt: 60,
  permissions: ['identity.read', 'projects.read', 'workspaces.read', 'reviews.read']
}
const self = await handlers.getSelf(binding, {} as ControlContext)
assert.equal(self.value?.workspace?.workspaceId, workspace.id)
assert.deepEqual(self.value?.project, { projectId: project.id, name: project.name })
assert.doesNotMatch(JSON.stringify(self.value?.project), /private|github|path/)

const status = await handlers.getWorkspaceStatus(workspace.id, {} as ControlContext)
assert.equal(status.value?.liveStatus, 'waiting')
assert.equal(status.observedAt, observedAt)

const transcript = await handlers.getWorkspaceTranscript(
  workspace.id,
  { role: 'user', limit: 1 },
  {} as ControlContext
)
assert.equal(transcript.value?.turns[0]?.text, 'new user')
const lastTurn = await handlers.getWorkspaceLastTurn(workspace.id, {} as ControlContext)
assert.equal(lastTurn.value?.assistantText, 'new assistant')
assert.deepEqual(await handlers.listReviewsByWorkspace(workspace.id, {} as ControlContext), [
  review
])

const source = fs.readFileSync(
  path.join(import.meta.dirname, '../src/main/controlPlane/transcriptObservation.ts'),
  'utf8'
)
assert.doesNotMatch(source, /\breadFile(?:Sync)?\s*\(/)

fs.rmSync(tempDir, { recursive: true, force: true })
console.log('verify-phase2-read-adapters: all assertions passed')
