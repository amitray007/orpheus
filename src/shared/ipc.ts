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
  OverlayEvent,
  CreateWorktreeParams,
  ClaudeWorkspaceSettings,
  ClaudeEffort,
  SessionRecord,
  SessionStatus,
  SessionsPagedRequest,
  SessionsPagedResult,
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch,
  GhosttyUserConfig,
  DiscoveredMcpServer,
  McpServerDraft,
  ClaudeSlashCommand,
  ClaudeSlashCommandDraft,
  ClaudeSubagent,
  ClaudeSubagentDraft,
  ClaudeHookEntry,
  ClaudeHookDraft,
  ClaudeAuthState,
  ClaudeAuthPatch,
  ClaudeAuthTestResult,
  ClaudeUsageResult,
  ClaudeUsage,
  ClaudeActivitySummary,
  ClaudeProjectSettings,
  ClaudeProjectSettingsOverrides,
  ClaudeWorkspaceSettingsOverrides,
  GitBranchInfo,
  GitCommit,
  UpdateSnapshot,
  RoutingProxySnapshot,
  RoutingProxyUpdateCheckResult,
  RoutingProxyAssetInfo,
  ProviderDescriptorSummary,
  ProviderConfigSummary,
  ProviderApiKeyEntrySummary,
  SelectableModel,
  ActionResult,
  ActionKind,
  ActionAuditEntry,
  FooterActionScope,
  FooterActionDraft,
  FooterActionDescriptor,
  KeepAwakeBaseMode,
  TerminalRect,
  TerminalMountResult,
  TerminalSendKeyDescriptor,
  OverlayDescriptor,
  OverlayShowResult,
  AppUiStatePatch,
  ContextMenuNativeItem,
  DetectedApp,
  FilesListing,
  GitStatusEntry,
  FileContents,
  FileImage,
  WriteFileResult,
  FilesMutationResult,
  GitDiffResult,
  GitDiffUnchangedResult,
  GhPullRequestDetail,
  GhReviewCommentThread,
  GhReviewComment,
  GhReviewCommentSide,
  GhSearchPr,
  GhSearchIssue,
  LocalReviewComment,
  PanePanel,
  PanePanelKind,
  PaneLayout,
  PaneTerminal,
  SplitTree,
  OAuthStartResult,
  OAuthPollResult
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
  'app:offeredModes': {
    req: [{ projectId: string }]
    res: { local: boolean; worktree: boolean }
  }
  'projects:list': { req: []; res: ProjectRecord[] }
  'pins:listAll': { req: []; res: PinnedItem[] }
  'doctor:check': { req: []; res: DoctorResult }
  'health:get': { req: []; res: HealthReport }
  'window:openDevTools': { req: []; res: void }
  'window:reload': { req: []; res: void }
  'config:openFolder': { req: []; res: string | null }
  'orpheusConfig:get': {
    req: [{ projectId: string }]
    res: { allowLocal: boolean; allowWorktree: boolean }
  }
  'orpheusConfig:setOverride': {
    req: [{ projectId: string; patch: Partial<{ allowLocal: boolean; allowWorktree: boolean }> }]
    res: { allowLocal: boolean; allowWorktree: boolean }
  }
  'diag:openConsole': { req: []; res: void }
  'diag:export': {
    req: [{ sinceMs: number }]
    res:
      | { ok: true; path: string; txtPath: string; jsonPath: string }
      | { ok: false; error: string }
  }
  'projects:add': { req: [{ path: string }]; res: ProjectRecord }
  'projects:pickAndAdd': { req: []; res: ProjectRecord | null }
  'projects:open': { req: [{ id: string }]; res: ProjectRecord }
  'projects:remove': {
    req: [{ id: string; deleteWorktrees?: boolean; force?: boolean }]
    res: { deleted: boolean; dirtyWorktrees: number }
  }
  'projects:worktreeSummary': { req: [{ projectId: string }]; res: { count: number } }
  'projects:rename': { req: [{ id: string; name: string }]; res: void }
  'projects:setExpandedInSidebar': {
    req: [{ id: string; expanded: boolean }]
    res: void
  }
  'projects:reorder': { req: [{ orderedIds: string[] }]; res: void }
  'projects:reorderByActivity': { req: []; res: string[] }
  'projects:setPinned': { req: [{ id: string; pinned: boolean }]; res: ProjectRecord }
  'projects:refreshGithub': { req: [string]; res: void }
  'workspaces:listForProject': {
    req: [{ projectId: string; scope?: 'active' | 'archived' | 'all' }]
    res: WorkspaceRecord[]
  }
  'workspaces:create': {
    req: [{ projectId: string; name: string; cwd: string }]
    res: WorkspaceRecord
  }
  'workspaces:createWorktree': {
    req: [{ projectId: string; params: CreateWorktreeParams }]
    res: WorkspaceRecord
  }
  'worktrees:branchExists': { req: [{ projectId: string; branch: string }]; res: boolean }
  'workspaces:open': { req: [{ id: string }]; res: WorkspaceRecord }
  'workspaces:setPinned': { req: [{ id: string; pinned: boolean }]; res: WorkspaceRecord }
  'workspaces:archive': {
    req: [{ id: string; force?: boolean }]
    res: { archived: boolean; wasDirty: boolean }
  }
  'workspace:close': {
    req: [{ id: string }]
    res: { ok: true; workspace: WorkspaceRecord | null } | { ok: false; error: 'busy' }
  }
  'workspace:reopen': {
    req: [{ id: string }]
    res: { ok: true; workspace: WorkspaceRecord | null }
  }
  'workspaces:rename': { req: [{ id: string; name: string }]; res: WorkspaceRecord }
  'workspaces:convertToLocal': { req: [{ id: string }]; res: WorkspaceRecord }
  'workspaces:reorder': {
    req: [{ projectId: string; orderedIds: string[] }]
    res: void
  }
  'workspace:isDirty': { req: [{ workspaceId: string }]; res: boolean }
  'workspace:getTitle': { req: [{ workspaceId: string }]; res: string | null }
  'workspace:setModel': {
    req: [{ workspaceId: string; model: string }]
    res: ClaudeWorkspaceSettings
  }
  'workspace:getEffectiveModel': { req: [{ workspaceId: string }]; res: { model: string } }
  'workspace:setEffort': {
    req: [{ workspaceId: string; effort: ClaudeEffort }]
    res: ClaudeWorkspaceSettings
  }
  'workspace:getEffectiveEffort': { req: [{ workspaceId: string }]; res: { effort: string } }
  'sessions:listForProject': {
    req: [{ projectId: string; includeArchived?: boolean }]
    res: SessionRecord[]
  }
  'sessions:listAll': { req: [{ status?: SessionStatus } | undefined]; res: SessionRecord[] }
  'sessions:setStatus': { req: [{ id: string; status: SessionStatus }]; res: void }
  'sessions:listForProjectPaged': { req: [SessionsPagedRequest]; res: SessionsPagedResult }
  'sessions:resumeInNewWorkspace': {
    req: [{ sessionId: string; projectId: string }]
    res: WorkspaceRecord
  }
  'sessions:resumeInWorktreeWorkspace': {
    req: [{ sessionId: string; projectId: string }]
    res: WorkspaceRecord
  }
  'sessions:refreshMetadata': { req: [{ projectId: string }]; res: void }
  'sessions:delete': { req: [{ id: string }]; res: void }
  'sessions:getContextBudget': {
    req: [{ workspaceId: string }]
    // contextBudget is null when the model's pricing/context window is
    // unknown — callers must render an explicit "unknown" state, never a
    // fabricated number. modelLabel is the registry's one canonical label
    // (src/main/models/registry.ts) — the renderer must not re-derive a
    // label from modelId itself. See ContextBudgetResult in
    // src/main/sessions.ts.
    res: { contextBudget: number | null; modelId: string; modelLabel: string }
  }
  'models:resolveLabels': {
    req: [{ modelIds: string[] }]
    // id -> the registry's one canonical label (src/main/models/registry.ts).
    // The renderer must consume this rather than parsing model ids itself.
    res: Record<string, string>
  }
  // The single selectable-model list for a workspace/project picker
  // (model-routing unit 06). `currentModelId` is optional — when provided
  // and it names a routed model that is no longer available (proxy down /
  // provider disconnected), that entry is still included in the result,
  // marked `available: false`, so a workspace's stored setting is never
  // silently dropped from the picker. See models:listSelectable's own doc
  // comment in src/main/ipc/models.ts for the full gating rules.
  'models:listSelectable': {
    req: [{ currentModelId?: string }]
    res: SelectableModel[]
  }
  'claudeSettings:get': { req: []; res: ClaudeGlobalSettings }
  'claudeSettings:update': { req: [ClaudeGlobalSettingsPatch]; res: ClaudeGlobalSettings }
  'ghosttySettings:get': { req: []; res: GhosttyUserConfig }
  'ghosttySettings:update': { req: [Partial<GhosttyUserConfig>]; res: GhosttyUserConfig }
  'mcp:listServers': { req: []; res: DiscoveredMcpServer[] }
  'mcp:add': { req: [McpServerDraft]; res: void }
  'mcp:update': {
    req: [
      {
        filePath: string
        oldName: string
        draft: Omit<McpServerDraft, 'source' | 'projectId'>
      }
    ]
    res: void
  }
  'mcp:delete': { req: [{ filePath: string; name: string }]; res: void }
  'claudeAgents:listSlashCommands': { req: []; res: ClaudeSlashCommand[] }
  'claudeAgents:listSubagents': { req: []; res: ClaudeSubagent[] }
  'claudeAgents:addSlashCommand': { req: [ClaudeSlashCommandDraft]; res: void }
  'claudeAgents:updateSlashCommand': {
    req: [{ filePath: string; draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'> }]
    res: void
  }
  'claudeAgents:deleteSlashCommand': { req: [{ filePath: string }]; res: void }
  'claudeAgents:addSubagent': { req: [ClaudeSubagentDraft]; res: void }
  'claudeAgents:updateSubagent': {
    req: [{ filePath: string; draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'> }]
    res: void
  }
  'claudeAgents:deleteSubagent': { req: [{ filePath: string }]; res: void }
  'claudeHooks:list': { req: []; res: ClaudeHookEntry[] }
  'claudeHooks:openFile': { req: [{ filePath: string }]; res: void }
  'claudeHooks:add': { req: [ClaudeHookDraft]; res: void }
  'claudeHooks:update': {
    req: [
      {
        filePath: string
        event: string
        matcherEntryIdx: number
        hookIdx: number
        draft: Omit<ClaudeHookDraft, 'source' | 'projectId'>
      }
    ]
    res: void
  }
  'claudeHooks:delete': {
    req: [{ filePath: string; event: string; matcherEntryIdx: number; hookIdx: number }]
    res: void
  }
  'claudeAuth:get': { req: []; res: ClaudeAuthState }
  'claudeAuth:update': { req: [ClaudeAuthPatch]; res: ClaudeAuthState }
  'claudeAuth:testConnection': { req: []; res: ClaudeAuthTestResult }
  // Dashboard "Usage" card — Claude's own undocumented usage/limits endpoint
  // (session 5h + weekly 7d utilization, per-model scoped limits). Main-
  // process TTL-cached (~3min) + inflight-deduped (src/main/claudeUsage.ts)
  // so repeated dashboard opens/re-renders never hammer the endpoint. Total
  // (never rejects) — degrades to `{ unavailable: 'no-auth' | 'error' }`.
  'claude:usage': { req: []; res: ClaudeUsageResult }
  // Instant, disk-backed companion to claude:usage above — reads the last-
  // persisted successful fetch (Dashboard D2 stale-while-revalidate). Cache
  // only ever stores the success shape, so `value` is `ClaudeUsage`, never
  // `unavailable`. `null` when no cache row exists yet (cold start).
  'claude:usage:cached': { req: []; res: { value: ClaudeUsage; fetchedAt: number } | null }
  // Dashboard "Your pulse" real activity — scanned directly off the on-disk
  // ~/.claude/projects/**/*.jsonl transcript store (src/main/claudeActivity.ts),
  // NOT the Orpheus `sessions` table, so it reflects ALL Claude usage, not
  // just Orpheus-registered workspaces. Same D1/D2 cached-first + fresh
  // pattern as claude:usage above. Total (never rejects).
  'claude:activity': { req: []; res: ClaudeActivitySummary }
  'claude:activity:cached': {
    req: []
    res: { value: ClaudeActivitySummary; fetchedAt: number } | null
  }
  'claudeProjectSettings:get': { req: [{ projectId: string }]; res: ClaudeProjectSettings }
  'claudeProjectSettings:update': {
    req: [{ projectId: string; patch: ClaudeProjectSettingsOverrides }]
    res: ClaudeProjectSettings
  }
  'claudeWorkspaceSettings:get': { req: [{ workspaceId: string }]; res: ClaudeWorkspaceSettings }
  'claudeWorkspaceSettings:update': {
    req: [{ workspaceId: string; patch: ClaudeWorkspaceSettingsOverrides }]
    res: ClaudeWorkspaceSettings
  }
  'git:status': { req: [{ cwd: string }]; res: GitStatus | null }
  'git:branches': { req: [{ cwd: string }]; res: GitBranchInfo[] }
  'git:log': {
    req: [
      {
        cwd: string
        branch?: string
        limit?: number
        offset?: number
        sinceMs?: number
        untilMs?: number
        grep?: string
      }
    ]
    res: GitCommit[]
  }
  'git:count': {
    req: [{ cwd: string; branch?: string; sinceMs?: number; untilMs?: number; grep?: string }]
    res: number
  }
  'github:prForBranch': { req: [{ cwd: string; branch: string }]; res: GhPullRequest | null }
  // Workbench Git tab — fetch-on-mount fallback for GitTab's `pr` state.
  // `startGitWatch` (src/main/git.ts) pushes `github:prChanged` exactly ONCE
  // on initial watch registration, async, at `terminal:mount` time — a
  // one-shot push that's usually already fired by the time the user
  // actually opens the Git tab (GitTab unmounts while its Workbench tab
  // isn't active), so `pr` stayed null forever with no way to self-heal.
  // This channel resolves workspaceId -> cwd -> current branch -> PR, same
  // composition as github:prDetail below, so GitTab can fetch it directly
  // on mount instead of relying solely on the push. See src/main/github.ts::
  // getPrForWorkspace.
  'github:prForWorkspace': { req: [{ workspaceId: string }]; res: GhPullRequest | null }
  // Workbench Git tab — Phase 3b rich PR detail (Details/Commits/Checks tabs,
  // Phase 4 general comments). Resolves `workspaceId` -> cwd -> current branch
  // -> PR number -> ONE `gh pr view` call. Total (never throws); null when
  // there's no PR/no gh/no remote. See src/main/github.ts::getPrDetail.
  'github:prDetail': { req: [{ workspaceId: string }]; res: GhPullRequestDetail | null }
  // Workbench Git tab — Phase 4a line-anchored PR review comments, threaded
  // server-side (`in_reply_to_id ?? id` grouping). SEPARATE gh call/cache from
  // prDetail above — see docs/learnings/pr-comments.md + src/main/github.ts::
  // getPrReviewComments. Total (never throws); null on any failure mode.
  'github:prReviewComments': { req: [{ workspaceId: string }]; res: GhReviewCommentThread[] | null }
  // Workbench Git tab — Phase 4c write operations. THE FIRST GitHub writes
  // this app makes. Each is total (never rejects) — see
  // src/main/github.ts's "PR write operations" section for the full
  // execFile-args-body-safety + error-extraction + cache-invalidation
  // rationale; `commitId` on postReviewComment is optional (server-side
  // falls back to the PR's live head sha via `gh pr view --json
  // headRefOid`) so a stale/omitted client-side sha still succeeds.
  'github:postReviewComment': {
    req: [
      {
        workspaceId: string
        path: string
        line: number
        side: GhReviewCommentSide
        body: string
        commitId?: string
      }
    ]
    res: { ok: true; value: GhReviewComment } | { ok: false; error: string }
  }
  'github:replyToReviewComment': {
    req: [{ workspaceId: string; commentId: number; body: string }]
    res: { ok: true; value: GhReviewComment } | { ok: false; error: string }
  }
  'github:postGeneralComment': {
    req: [{ workspaceId: string; body: string }]
    res: { ok: true } | { ok: false; error: string }
  }
  // Dashboard Phase 2 (U5) — account-wide GitHub search, no cwd/workspace
  // scoping (unlike every github:* channel above). See src/main/github.ts::
  // getMyOpenPrs/getMyIssues for the full field-shape research + cache
  // contract. Total (never rejects) — both resolve to [] on any gh failure
  // mode; the Dashboard tables render their empty state in that case.
  'github:myOpenPrs': { req: []; res: GhSearchPr[] }
  'github:myIssues': { req: []; res: GhSearchIssue[] }
  // Instant, disk-backed companions to the two channels above — read the
  // last-persisted successful fetch (Dashboard D2 stale-while-revalidate).
  // `null` when no cache row exists yet (cold start).
  'github:myOpenPrs:cached': { req: []; res: { value: GhSearchPr[]; fetchedAt: number } | null }
  'github:myIssues:cached': { req: []; res: { value: GhSearchIssue[]; fetchedAt: number } | null }
  // Dashboard D4 — refresh the signed-in gh user's display name on each app
  // open. Resolves via `gh api user`, persists the result to app_ui_state's
  // github_username column, and returns the resolved display name (name ||
  // login). Total (never rejects): on any gh failure, returns null and
  // leaves the previously-stored value untouched (keep last-good).
  'github:refreshUsername': { req: []; res: string | null }
  // Workbench Git tab — Phase 4d. The LOCAL (Orpheus-owned) review-comment
  // store — see src/main/reviewStore.ts's own header for the full Epic G2
  // rationale (the 3-source comment model, the agent-readable DB/commandServer
  // hook). Total (never rejects on a missing row for list/add; setResolved/
  // delete on an unknown id are simple SQLite no-ops, not error paths).
  'reviews:list': { req: [{ workspaceId: string }]; res: LocalReviewComment[] }
  'reviews:add': {
    req: [
      {
        workspaceId: string
        prNumber?: number | null
        path: string
        line?: number | null
        startLine?: number | null
        side?: GhReviewCommentSide | null
        body: string
      }
    ]
    res: LocalReviewComment
  }
  'reviews:setResolved': { req: [{ id: string; resolved: boolean }]; res: LocalReviewComment }
  'reviews:delete': { req: [{ id: string }]; res: void }
  // Panes v2 — top-level Panels · Layouts · split Panes
  // (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U4).
  // REPLACES the flat-row Panes CRUD (U12) with the panel -> layout ->
  // terminal hierarchy. See src/main/paneStore.ts. Update/delete on an
  // unknown id throws (mirroring paneStore.ts's own contract); list/create
  // never reject.
  'panes:listPanels': { req: []; res: PanePanel[] }
  'panes:createPanel': {
    req: [{ kind: PanePanelKind; name: string; dir?: string | null; position?: number }]
    res: PanePanel
  }
  'panes:updatePanel': {
    req: [{ id: string; name?: string; dir?: string | null; position?: number }]
    res: PanePanel
  }
  'panes:deletePanel': { req: [{ id: string }]; res: void }
  // Sidebar expand/collapse persistence (issue #1) — mirrors
  // projects:setExpandedInSidebar's shape exactly. See src/main/paneStore.ts's
  // setPanelExpanded.
  'panes:setPanelExpanded': { req: [{ id: string; expanded: boolean }]; res: void }
  // Fix 4 — per-layout auto-start toggle (mirrors panes:setPanelExpanded's
  // shape). See src/main/paneStore.ts's setLayoutAutoStart.
  'panes:setLayoutAutoStart': { req: [{ id: string; autoStart: boolean }]; res: PaneLayout }
  'panes:listLayouts': { req: [{ panelId: string }]; res: PaneLayout[] }
  'panes:createLayout': {
    req: [{ panelId: string; name: string; dir: string; position?: number }]
    res: PaneLayout
  }
  'panes:updateLayout': {
    req: [
      {
        id: string
        name?: string
        dir?: string
        splitTree?: SplitTree | null
        position?: number
      }
    ]
    res: PaneLayout
  }
  'panes:deleteLayout': { req: [{ id: string }]; res: void }
  // Fix 4 — on-demand per-layout background Start/Stop from the sidebar
  // context menu, independent of auto-start-on-launch. Start mounts+hides
  // every pane in the layout's split tree (same path boot auto-start uses);
  // Stop destroys every live pane surface for the layout.
  'panes:startLayoutBackground': { req: [{ id: string }]; res: void }
  'panes:stopLayout': { req: [{ id: string }]; res: void }
  'panes:listTerminals': { req: [{ layoutId: string }]; res: PaneTerminal[] }
  'panes:createTerminal': {
    req: [{ layoutId: string; command: string; name?: string; position: number }]
    res: PaneTerminal
  }
  'panes:updateTerminal': {
    req: [{ id: string; command?: string; name?: string; position?: number }]
    res: PaneTerminal
  }
  'panes:deleteTerminal': { req: [{ id: string }]; res: void }
  // Folder picker (KTD8) — Panes-only; the chosen path is never written to
  // the `projects` table. See src/main/ipc/panes.ts.
  'panes:pickDirectory': { req: []; res: string | null }
  // Workbench Git tab — Phase 1 working-tree diff (per-file unified-diff
  // patch strings, resolved from `workspaceId` like the files:* channels
  // below). See src/main/gitDiff.ts + docs/learnings/pierre-libraries.md §13.
  // PERF FIX (main-side diff no-op detection) — `res` is a UNION with
  // GitDiffUnchangedResult: main may return the additive `{ unchanged: true }`
  // sentinel instead of `files[]` when this exact workspace's diff hasn't
  // changed since the last `git:diff` call (see GitDiffUnchangedResult's own
  // doc comment). `git:prDiff` below is intentionally NOT part of this union —
  // it keeps the plain `GitDiffResult` shape unchanged.
  // BUG FIX (stuck-loading) — optional `forceFresh` bypasses the main-side
  // signature-cache LOOKUP for this one call (see gitDiff.ts's
  // getWorkingTreeDiff doc comment): the cache lives for the main process's
  // lifetime, independent of the renderer's Git tab mount/unmount, so a
  // reopened tab must be able to force a full result rather than risk
  // replaying a stale `{ unchanged: true }` from a previous mount.
  'git:diff': {
    req: [{ workspaceId: string; forceFresh?: boolean }]
    res: GitDiffResult | GitDiffUnchangedResult
  }
  // Workbench Git tab — Phase 4-pre PR-diff mode (the [Working tree | PR
  // diff] toggle). Resolves `workspaceId` -> cwd -> current branch's PR ->
  // `gh pr diff <n>`, parsed with the SAME splitPatchByFile/fileFromChunk
  // git:diff uses (identical `diff --git` format) — see
  // src/main/gitDiff.ts::getPrDiff. Total (never rejects); `{ repo, files:
  // [] }` when there's no PR/no gh/network failure (safety net — the
  // renderer only offers this mode once it already knows a PR exists).
  'git:prDiff': { req: [{ workspaceId: string }]; res: GitDiffResult }
  // Workbench Git tab — Phase 2 "Not a git repository" empty state's Git-init
  // button. Resolves `workspaceId` -> cwd like git:diff; total (never
  // rejects) so the renderer can show inline success/failure feedback. See
  // src/main/git.ts's gitInit + src/main/ipc/git.ts.
  'git:init': { req: [{ workspaceId: string }]; res: { ok: true } | { ok: false; error: string } }
  // Workbench Git tab — Phase 3c Commits sub-tab's no-PR fallback (branch has
  // local commits but no PR yet). Resolves `workspaceId` -> cwd like
  // git:diff/git:init above, rather than taking a bare `cwd` like the
  // existing `git:log` — CommitsTab.tsx only ever has `workspaceId`, same as
  // GitTab's other props, and has no other route to a raw cwd string.
  'git:logForWorkspace': { req: [{ workspaceId: string; limit?: number }]; res: GitCommit[] }
  // Workbench Git tab — Pierre adoption batch 4 (safe/read-only slice):
  // conflict DETECTION only, no resolution write-back. Resolves `workspaceId`
  // -> cwd like git:diff/git:init above, then runs a read-only `git status
  // --porcelain=v1` and returns the repo-relative paths whose XY code is one
  // of the nine "unmerged" combinations (UU/AA/DD/AU/UA/DU/UD — see
  // src/main/git.ts's getConflictedPaths). Total (never rejects) — `[]` for a
  // non-repo, a clean tree, or any git failure. The renderer (GitTab.tsx) uses
  // this to gate its @pierre/diffs <UnresolvedFile> conflict-viewer branch;
  // it performs NO git mutation of any kind.
  'git:conflicts': { req: [{ workspaceId: string }]; res: string[] }
  // Per-hunk "Revert" feature (setting-gated, AppUiState.hunkActionsEnabled) —
  // READ-ONLY `git show HEAD:<path>`, the file's content at HEAD. Resolves
  // `workspaceId` -> cwd like git:diff/git:init above. Total (never
  // rejects) — `null` for an untracked/new file (no HEAD version), a
  // non-repo, or any git failure. See docs/learnings/hunk-accept-reject.md
  // and src/main/git.ts's getFileAtHead.
  'git:showHead': { req: [{ workspaceId: string; path: string }]; res: string | null }
  // Workbench Files tab — file tree + viewer data sources (Stage A). All three
  // resolve the workspace's cwd from `workspaceId` internally; res types live
  // in src/shared/types.ts. See docs/learnings/pierre-libraries.md §7.
  'files:listDir': { req: [{ workspaceId: string }]; res: FilesListing }
  'files:gitStatus': { req: [{ workspaceId: string }]; res: GitStatusEntry[] }
  'files:readFile': {
    req: [{ workspaceId: string; path: string }]
    res: FileContents
  }
  // Image bytes for the Files-tab viewer's `<img>` branch — base64 data URL,
  // size-capped separately from text reads (images tend to be larger and are
  // never truncated-and-shown-partial the way text is). See FileImage.
  'files:readImage': {
    req: [{ workspaceId: string; path: string }]
    res: FileImage
  }
  'files:writeFile': {
    req: [{ workspaceId: string; path: string; contents: string }]
    res: WriteFileResult
  }
  // Workbench Files tab — tree mutations (Phase 4). Each guards its relative
  // path(s) through resolveInside (rejecting `../` escapes) and is total (a
  // FilesMutationResult, never a throw). See docs/learnings/pierre-libraries.md
  // §10.5. `files:delete` moves the target to the OS Trash (recoverable).
  'files:createFile': { req: [{ workspaceId: string; path: string }]; res: FilesMutationResult }
  'files:createDir': { req: [{ workspaceId: string; path: string }]; res: FilesMutationResult }
  'files:rename': {
    req: [{ workspaceId: string; from: string; to: string }]
    res: FilesMutationResult
  }
  'files:delete': { req: [{ workspaceId: string; path: string }]; res: FilesMutationResult }
  // Resolve a workspace-relative path to its ABSOLUTE form (guarded via
  // resolveInside), so the renderer can hand an absolute path to the existing
  // shell:* IPCs (revealInFinder / openInEditor / copyToClipboard), which
  // assertAbsolutePath server-side. Returns null on a traversal escape / no
  // workspace.
  'files:absolutePath': {
    req: [{ workspaceId: string; path: string }]
    res: string | null
  }
  // Working-tree file watcher (main/filesWatcher.ts) — active only while the
  // Workbench Files tab is open for a workspace, so an external edit (Claude,
  // a terminal command, `git checkout`) keeps the tree live instead of going
  // stale until the next tab open. AT MOST ONE watcher runs at a time.
  'files:watchStart': { req: [{ workspaceId: string }]; res: void }
  'files:watchStop': { req: [{ workspaceId: string }]; res: void }
  // Git tab avatars (Avatar.tsx) — fetch-once, disk-cached GitHub avatar.
  // `url` is the GitHub CDN url captured alongside a comment/review (see
  // src/main/avatarCache.ts); resolves to a small `data:image/...;base64,...`
  // URI, or `null` on any fetch/network/fs failure (never rejects — the
  // renderer falls back to the direct sized CDN url, then the initials
  // circle).
  'avatar:get': { req: [{ url: string }]; res: string | null }
  'updates:check': { req: []; res: UpdateCheckResult }
  'updates:install': { req: []; res: void }
  'updates:restart': { req: []; res: void }
  'updates:getState': { req: []; res: UpdateSnapshot }
  // Managed routing proxy (model-routing unit 04) — see src/main/routingProxy/.
  'routingProxy:getState': { req: []; res: RoutingProxySnapshot }
  'routingProxy:setEnabled': { req: [{ enabled: boolean }]; res: RoutingProxySnapshot }
  'routingProxy:install': { req: []; res: RoutingProxySnapshot }
  'routingProxy:getAssetInfo': { req: []; res: RoutingProxyAssetInfo | null }
  'routingProxy:checkForUpdate': { req: []; res: RoutingProxyUpdateCheckResult }
  'routingProxy:refreshAuthFiles': { req: []; res: RoutingProxySnapshot }

  // Provider framework (model-routing unit 05) — see
  // src/main/routingProxy/providers/. 'providers:descriptors' returns the
  // static declarative list (PROVIDERS in providers/registry.ts) so the UI
  // can render an unconfigured provider before any config row exists.
  // 'providers:list' returns each configured provider merged with its live
  // connection status.
  'providers:descriptors': { req: []; res: ProviderDescriptorSummary[] }
  'providers:list': { req: []; res: ProviderConfigSummary[] }
  'providers:setEnabled': {
    req: [{ providerId: string; enabled: boolean }]
    res: ProviderConfigSummary[]
  }
  'providers:setApiKeys': {
    req: [{ providerId: string; apiKeys: ProviderApiKeyEntrySummary[] }]
    res: ProviderConfigSummary[]
  }
  'providers:setBaseUrl': {
    req: [{ providerId: string; baseUrl: string | null }]
    res: ProviderConfigSummary[]
  }

  // OAuth "Connect <provider>" flow (model-routing unit 07) — see
  // src/main/routingProxy/oauth.ts. 'oauth:start' opens the provider's
  // auth-url in the default browser and returns the url/state (+ device-flow
  // fields) so the UI can also show them as a fallback. 'oauth:poll' is
  // called on a client-side 2s interval by the renderer (not server-driven)
  // so the dialog can show its own countdown/cancel affordance; each call is
  // a single get-auth-status check, not the whole bounded wait loop — the
  // renderer decides when to stop polling (success/error/timeout/cancel).
  'oauth:start': { req: [{ providerId: string }]; res: OAuthStartResult }
  'oauth:poll': { req: [{ state: string }]; res: OAuthPollResult }
  'oauth:cancel': { req: [{ state: string }]; res: void }
  'status:get': { req: []; res: ClaudeStatusSnapshot }
  'status:refresh': { req: []; res: ClaudeStatusSnapshot }
  'status:openPage': { req: []; res: void }
  'actions:invoke': {
    req: [
      {
        actionId: string
        params: Record<string, unknown>
        workspaceId: string
        consumerHint?: string
      }
    ]
    res: ActionResult
  }
  'actions:list': { req: []; res: Array<{ id: string; kind: ActionKind }> }
  'actions:history': { req: [{ workspaceId: string; limit?: number }]; res: ActionAuditEntry[] }
  'actions:subscribe': {
    req: [
      {
        subscriptionId: string
        actionId: string
        params: Record<string, unknown>
        workspaceId: string
      }
    ]
    res: { ok: true }
  }
  'actions:unsubscribe': { req: [{ subscriptionId: string }]; res: { ok: true } }
  'footerActions:listMerged': { req: [{ workspaceId: string }]; res: FooterActionDescriptor[] }
  'footerActions:listAtScope': {
    req: [{ scope: FooterActionScope; scopeId?: string }]
    res: FooterActionDescriptor[]
  }
  'footerActions:create': {
    req: [{ scope: FooterActionScope; scopeId: string | null; draft: FooterActionDraft }]
    res: FooterActionDescriptor
  }
  'footerActions:update': {
    req: [{ id: string; patch: Partial<FooterActionDraft> }]
    res: FooterActionDescriptor
  }
  'footerActions:remove': { req: [{ id: string }]; res: void }
  'footerActions:reorder': {
    req: [{ scope: FooterActionScope; scopeId: string | null; orderedIds: string[] }]
    res: void
  }
  'footerActions:resetDefaults': { req: []; res: void }
  'keepAwake:get': { req: []; res: KeepAwakeState }
  'keepAwake:setMode': { req: [KeepAwakeBaseMode]; res: KeepAwakeState }
  'keepAwake:setDisplayOn': { req: [boolean]; res: KeepAwakeState }
  'keepAwake:startTimer': { req: [number]; res: KeepAwakeState }
  'terminal:mount': {
    req: [{ workspaceId: string; rect: TerminalRect; scaleFactor: number; cwd?: string }]
    res: TerminalMountResult
  }
  'terminal:hide': { req: [{ workspaceId: string }]; res: void }
  'terminal:focus': { req: [{ workspaceId: string }]; res: void }
  'terminal:getSurfacePhase': {
    req: [{ workspaceId: string }]
    res: 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'
  }
  'terminal:resize': {
    req: [{ workspaceId: string; rect: TerminalRect; scaleFactor: number }]
    res: void
  }
  'terminal:destroy': { req: [{ workspaceId: string }]; res: void }
  'terminal:sendInput': { req: [{ workspaceId: string; text: string }]; res: ActionResult }
  'terminal:sendKeys': {
    req: [{ workspaceId: string; keys: TerminalSendKeyDescriptor[] }]
    res: ActionResult
  }
  'terminal:submit': { req: [{ workspaceId: string }]; res: ActionResult }
  'terminal:clearInput': { req: [{ workspaceId: string }]; res: ActionResult }
  'terminal:canInject': { req: [{ workspaceId: string }]; res: boolean }
  // Workbench Terminal-tab surface(s). U6b mounted ONE plain $SHELL surface
  // per claude workspace, keyed `workbench:<workspaceId>` in the native addon
  // (see docs/learnings/native-multisurface-investigation.md §1 for the slot
  // model this relies on). U8 (P3) generalizes this to a STRIP of N ad-hoc
  // terminals per claude workspace: the optional `terminalId` (a renderer-
  // owned monotonic counter, omitted for the U6b single-shell call sites)
  // keys the addon slot as `workbench:<workspaceId>:<terminalId>` — still
  // prefixed `workbench:`, so it still routes to the single-visible
  // Workbench slot and auto-evicts whichever sibling terminal was visible.
  // `workspaceId` here is always the OWNING claude workspace's id (used for
  // the cwd lookup) — never the derived slot key.
  'workbench:mount': {
    req: [{ workspaceId: string; rect: TerminalRect; scaleFactor: number; terminalId?: number }]
    res: { workspaceId: string; created: boolean }
  }
  'workbench:resize': {
    req: [{ workspaceId: string; rect: TerminalRect; scaleFactor: number; terminalId?: number }]
    res: void
  }
  'workbench:hide': { req: [{ workspaceId: string; terminalId?: number }]; res: void }
  'workbench:destroy': { req: [{ workspaceId: string; terminalId?: number }]; res: void }
  // Workbench Panes tab (U12) surface mount — a SIBLING of workbench:* above,
  // not a variant of it: each declared pane gets its own dedicated native
  // slot keyed `pane:<workspaceId>:<paneId>` (see paneSlotId in
  // src/main/index.ts) so N panes stay simultaneously visible/interactive,
  // unlike workbench:*'s single-visible-slot eviction model. `command` is
  // the pane's user-declared command string (run via resources/orpheus-
  // pane.sh, which drops to an interactive shell once it exits so the pane
  // never dies — see that script's own header).
  'pane:mount': {
    req: [
      {
        workspaceId: string
        paneId: string
        rect: TerminalRect
        scaleFactor: number
        command: string
      }
    ]
    res: TerminalMountResult
  }
  'pane:resize': {
    req: [{ workspaceId: string; paneId: string; rect: TerminalRect; scaleFactor: number }]
    res: void
  }
  'pane:hide': { req: [{ workspaceId: string; paneId: string }]; res: void }
  'pane:destroy': { req: [{ workspaceId: string; paneId: string }]; res: void }
  'overlay:showDescriptor': { req: [{ descriptor: OverlayDescriptor }]; res: OverlayShowResult }
  'overlay:update': { req: [{ id: string; props: Record<string, unknown> }]; res: void }
  'overlay:hide': { req: [{ id: string }]; res: void }
  'uiState:get': { req: []; res: AppUiState }
  'uiState:update': { req: [AppUiStatePatch]; res: AppUiState }
  'hooks:setEnabled': { req: [boolean]; res: { enabled: boolean } }
  'hooks:getStatus': { req: []; res: { enabled: boolean; installed: number } }
  'notifications:test': { req: []; res: void }
  'contextMenu:show': { req: [ContextMenuNativeItem[]]; res: string | null }
  'shell:revealInFinder': { req: [{ path: string }]; res: void }
  'shell:openInEditor': { req: [{ path: string }]; res: void }
  'shell:openTerminal': { req: [{ path: string }]; res: void }
  'shell:copyToClipboard': { req: [{ text: string }]; res: void }
  'shell:listEditorApps': { req: []; res: DetectedApp[] }
  'shell:listTerminalApps': { req: []; res: DetectedApp[] }
  // Dashboard Phase 2 (U5) — row-click on a PR/issue opens its GitHub url in
  // the OS default browser. Guarded main-side by the SAME isSafeExternalUrl
  // allowlist src/main/index.ts already uses for window.open's
  // setWindowOpenHandler (src/main/ipc/validate.ts) — never opens an
  // arbitrary/unsafe scheme even though the urls here always originate from
  // gh's own response, not user input.
  'shell:openExternal': { req: [{ url: string }]; res: void }
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
  'workbench:terminalTitleChanged': {
    workspaceId: string
    terminalId: number
    title: string | null
  }
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
  // Working-tree change notification from filesWatcher.ts — pushed (debounced)
  // whenever a non-denylisted path changes while the Files tab's watcher is
  // active for `workspaceId`. The renderer refetches listing + git status.
  'files:changed': { workspaceId: string }
  'updates:progress': UpdateProgress
  'updates:done': { success: boolean; code: number | null }
  'updates:checkResult': UpdateCheckResult
  // Managed routing proxy — pushed on every status/progress/authFiles change
  // so the Settings panel updates live without polling (mirrors updates:*).
  'routingProxy:snapshot': RoutingProxySnapshot
  'status:change': ClaudeStatusSnapshot
  // Dashboard "Usage" card background poller (D3) — pushed on each successful
  // poll tick (see src/main/usagePoller.ts) so the renderer can silently
  // update in place without a manual refresh or a skeleton flash. Failed/
  // unavailable ticks are NOT pushed — the renderer keeps showing last-good
  // cached data.
  'claude:usagePushed': ClaudeUsage
  // Dashboard "Your pulse" background poller (see src/main/claudeActivityPoller.ts)
  // — pushed on each successful scan tick so the renderer updates silently
  // in place. Same "don't push on failure" contract as claude:usagePushed.
  'claude:activityPushed': ClaudeActivitySummary
  'actions:subscription-update': { subscriptionId: string; value: unknown }
  'diag:stream': unknown[]
  'keepAwake:state': KeepAwakeState
  'overlay:event': OverlayEvent
  // Panes v2 — issue #24 sidebar running loader. Pushed whenever main's
  // paneSurfacesByWorkspace map (src/main/index.ts — keyed LAYOUT id -> set
  // of live paneIds, despite the map's "workspace" name; see that map's own
  // header comment) gains or loses its last live surface for some layout.
  // Payload is the FULL current set of layout ids with >=1 live surface
  // (not a delta) — cheap to recompute (a Map.keys() filter) and trivially
  // idempotent for the renderer store to apply, so no ordering/dedup logic
  // is needed on either side. See paneLiveLayoutsStore.ts.
  'panes:liveLayoutsChanged': { layoutIds: string[] }
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
  workbenchTerminalTitleChanged: 'workbench:terminalTitleChanged',
  workspaceActivityBatch: 'workspace:activityBatch',
  workspaceNavigateTo: 'workspace:navigateTo',
  workspaceRequestOpen: 'workspace:requestOpen',
  workspacesCreated: 'workspaces:created',
  workspacesArchived: 'workspaces:archived',
  workspacesChanged: 'workspaces:changed',
  uiStateChanged: 'uiState:changed',
  gitStatusChanged: 'git:statusChanged',
  githubPrChanged: 'github:prChanged',
  filesChanged: 'files:changed',
  updatesProgress: 'updates:progress',
  updatesDone: 'updates:done',
  updatesCheckResult: 'updates:checkResult',
  routingProxySnapshot: 'routingProxy:snapshot',
  statusChange: 'status:change',
  claudeUsagePushed: 'claude:usagePushed',
  claudeActivityPushed: 'claude:activityPushed',
  actionsSubscriptionUpdate: 'actions:subscription-update',
  diagStream: 'diag:stream',
  keepAwakeState: 'keepAwake:state',
  overlayEvent: 'overlay:event',
  panesLiveLayoutsChanged: 'panes:liveLayoutsChanged'
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
