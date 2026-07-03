// ---------------------------------------------------------------------------
// Typed IPC channel maps (DUP-3, chunk A — foundation only).
//
// This file is the single source of truth for the *shape* of IPC traffic
// between main and renderer. It imports ONLY from `./types` — nothing from
// `src/main`, `src/preload`, or `src/renderer` (enforced by the
// `shared-not-to-*` depcruise rules; keep it that way).
//
// Two maps:
//   - `InvokeChannelMap`  — request/response channels driven via
//     `ipcMain.handle` / `ipcRenderer.invoke`.
//   - `RendererPushMap`   — fire-and-forget channels main pushes to the
//     renderer via `webContents.send` / consumed via `ipcRenderer.on`.
//
// Error-shape convention (documented here for future migration commits,
// NOT enforced/migrated yet):
//   - A thrown error crossing the invoke boundary means a PROGRAMMER error
//     (bad input, invariant violation, unexpected exception) — the renderer
//     is not expected to recover gracefully, it's a bug to fix.
//   - An `ActionResult` (see `./types`) return value means an EXPECTED
//     outcome the UI should branch on (success/failure the user can act on,
//     e.g. "workspace is dirty, confirm force"). Do not conflate the two:
//     don't throw for expected outcomes, and don't return an `ActionResult`
//     shape to paper over a real bug.
// ---------------------------------------------------------------------------

import type {
  ProjectRecord,
  PinnedItem,
  DoctorResult,
  HealthReport,
  WorkspaceRecord,
  WorkspaceStatus,
  WorkspaceActivityDetail,
  AppUiState,
  GitStatus,
  GhPullRequest,
  ClaudeStatusSnapshot,
  UpdateProgress,
  UpdateCheckResult,
  KeepAwakeState,
  OverlayEvent
} from './types'

// ---------------------------------------------------------------------------
// Invoke channels (request/response)
// ---------------------------------------------------------------------------

/**
 * Channel name -> { req: [...tuple of args after the IpcMainInvokeEvent],
 * res: return type }. Seeded with a handful of simple, zero/low-arg reads.
 * The remaining ~100+ invoke channels stay untyped (permissive fallback
 * overload) and are migrated domain-by-domain in follow-up commits.
 */
export interface InvokeChannelMap {
  'app:getVersion': { req: []; res: string }
  'app:getPaths': { req: []; res: { userData: string; logs: string } }
  'projects:list': { req: []; res: ProjectRecord[] }
  'pins:listAll': { req: []; res: PinnedItem[] }
  'doctor:check': { req: []; res: DoctorResult }
  'health:get': { req: []; res: HealthReport }
  'window:openDevTools': { req: []; res: void }
  'window:reload': { req: []; res: void }
  // … migrated domain-by-domain in follow-up commits.
}

export type InvokeChannel = keyof InvokeChannelMap
export type Req<C extends InvokeChannel> = InvokeChannelMap[C]['req']
export type Res<C extends InvokeChannel> = InvokeChannelMap[C]['res']

// ---------------------------------------------------------------------------
// Renderer push channels (main -> renderer, fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Channel name -> event payload type, for every channel main currently
 * pushes to the renderer main window via `webContents.send` and the
 * renderer listens for via `ipcRenderer.on` in `src/preload/index.ts`.
 * (The separate overlay-window preload, `src/preload/overlay.ts`, has its
 * own `overlayRenderer:*` channels and is out of scope here.)
 */
export interface RendererPushMap {
  'addon:actionTrace': { tagName: string }
  'terminal:canInjectChanged': { workspaceId: string; canInject: boolean }
  'terminal:sleepStateChanged': { workspaceId: string; sleeping: boolean }
  'terminal:liveness': {
    workspaceId: string
    inputTick: number
    liveTick: number
    occluded: boolean
  }
  'terminal:activeWorkspaceChanged': { workspaceId: string | null }
  'projects:githubDataUpdated': {
    projectId: string
    githubOwner: string | null
    githubRepo: string | null
    githubAvatarUrl: string | null
    githubCheckedAt: number
  }
  'workspace:dirtyChanged': { workspaceId: string; dirty: boolean }
  'workspace:titleChanged': { workspaceId: string; title: string | null }
  'workspace:activityBatch': Array<{
    workspaceId: string
    status: WorkspaceStatus
    detail: WorkspaceActivityDetail
  }>
  'workspace:navigateTo': { workspaceId: string; projectId?: string }
  'workspace:requestOpen': { workspaceId: string; focus?: boolean }
  'workspaces:created': { workspace: WorkspaceRecord }
  'workspaces:archived': { workspaceId: string; projectId: string }
  'workspaces:changed': { workspace: WorkspaceRecord }
  'uiState:changed': AppUiState
  'git:statusChanged': { workspaceId: string; status: GitStatus }
  'github:prChanged': { workspaceId: string; pr: GhPullRequest | null }
  'updates:progress': UpdateProgress
  'updates:done': { success: boolean; code: number | null }
  'updates:checkResult': UpdateCheckResult
  'status:change': ClaudeStatusSnapshot
  'actions:subscription-update': { subscriptionId: string; value: unknown }
  'diag:stream': unknown[]
  'keepAwake:state': KeepAwakeState
  'overlay:event': OverlayEvent
}

export type PushChannel = keyof RendererPushMap
export type PushPayload<C extends PushChannel> = RendererPushMap[C]

/**
 * MDB-10: the single place the 25 push-channel literals are spelled. Main
 * (`webContents.send`) and preload (`ipcRenderer.on` via `subscribe`) both
 * import from here so a typo on either side is a compile error instead of a
 * silently-dead channel. Keys match `RendererPushMap` — `keyof` below fails
 * to compile if the two ever drift apart.
 */
export const PUSH_CHANNELS = {
  addonActionTrace: 'addon:actionTrace',
  terminalCanInjectChanged: 'terminal:canInjectChanged',
  terminalSleepStateChanged: 'terminal:sleepStateChanged',
  terminalLiveness: 'terminal:liveness',
  terminalActiveWorkspaceChanged: 'terminal:activeWorkspaceChanged',
  projectsGithubDataUpdated: 'projects:githubDataUpdated',
  workspaceDirtyChanged: 'workspace:dirtyChanged',
  workspaceTitleChanged: 'workspace:titleChanged',
  workspaceActivityBatch: 'workspace:activityBatch',
  workspaceNavigateTo: 'workspace:navigateTo',
  workspaceRequestOpen: 'workspace:requestOpen',
  workspacesCreated: 'workspaces:created',
  workspacesArchived: 'workspaces:archived',
  workspacesChanged: 'workspaces:changed',
  uiStateChanged: 'uiState:changed',
  gitStatusChanged: 'git:statusChanged',
  githubPrChanged: 'github:prChanged',
  updatesProgress: 'updates:progress',
  updatesDone: 'updates:done',
  updatesCheckResult: 'updates:checkResult',
  statusChange: 'status:change',
  actionsSubscriptionUpdate: 'actions:subscription-update',
  diagStream: 'diag:stream',
  keepAwakeState: 'keepAwake:state',
  overlayEvent: 'overlay:event'
} satisfies Record<string, PushChannel>

// Exhaustiveness check: every PushChannel must appear as a value above (the
// `satisfies` above already guarantees the converse — no value can be an
// invalid PushChannel). If a channel is added to RendererPushMap but not to
// PUSH_CHANNELS, `_PushChannelsCoverAllKeys` narrows to `never` and this
// assignment fails to compile. Exported (not just declared) so it's an
// actual checked assertion, not a dead, unevaluated type alias.
type _PushChannelsCoverAllKeys =
  PushChannel extends (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS] ? true : never
export const _assertPushChannelsExhaustive: _PushChannelsCoverAllKeys = true
