import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  Terminal as TerminalIcon,
  Gear,
  ArrowBendUpLeft,
  Cpu,
  Info,
  GitBranch
} from '@phosphor-icons/react'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'
import type { GhPullRequest, WorkspaceRecord, SessionUsage, SessionCost } from '@shared/types'
import { PrChip } from '../github/PrChip'
import { useGitStatus } from '@/lib/gitStore'
import {
  showDetailsPopover,
  updateDetailsPopover,
  hideNativePopover,
  onNativePopoverClosed,
  gitStatusToNative,
  prToNative
} from '@/lib/nativePopover'
import type { DetailsPopoverData } from '@/lib/nativePopover'
import { contextBudgetCache } from './workspaceTitleBar.helpers'
import type { ContextBudgetInfo } from './workspaceTitleBar.helpers'

// ---------------------------------------------------------------------------
// Model label helper — derives a short human-readable label from a model ID.
// ---------------------------------------------------------------------------
function modelLabel(modelId: string): string {
  // 1. Exact match in known options
  const known = CLAUDE_MODEL_OPTIONS.find((o) => o.value === modelId)
  if (known) return known.label

  // 2. Prefix match — handles date-stamped variants like "claude-opus-4-7-20260416"
  //    by finding the longest known option whose value is a prefix of the incoming ID.
  const prefixMatch = CLAUDE_MODEL_OPTIONS.filter((o) => modelId.startsWith(o.value)).reduce<
    (typeof CLAUDE_MODEL_OPTIONS)[number] | undefined
  >((best, o) => (best === undefined || o.value.length > best.value.length ? o : best), undefined)
  if (prefixMatch) return prefixMatch.label

  // 3. Structural parse: "claude-<family>-<v1>-<v2>..." → "<Family> <v1>.<v2>"
  //    Strips the leading "claude-" then splits on "-".
  //    family = first segment (capitalized), version = subsequent numeric segments joined by ".".
  const parts = modelId.replace(/^claude-/, '').split('-')
  if (parts.length >= 1) {
    const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
    const versionParts = parts.slice(1).filter((p) => /^\d/.test(p))
    if (versionParts.length > 0) {
      return `${family} ${versionParts.join('.')}`
    }
    return family
  }

  return modelId
}

// ---------------------------------------------------------------------------
// Short token helper — same as contextLabel but without the " ctx" suffix.
// ---------------------------------------------------------------------------
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

// ---------------------------------------------------------------------------
// ModelContextChip — small read-only chip showing model + context mode.
// Fetches context budget once on mount; stays static until workspace changes.
//
// Module-level cache: seeded on first fetch per workspace, invalidated when
// the session ID changes (handled by the workspaceId + sessionId key below).
// On switch-back the chip renders the stale value immediately (no layout shift
// or late-appear flash) while the fresh fetch runs in the background.
// ---------------------------------------------------------------------------

interface ModelContextChipProps {
  workspaceId: string
  /** claudeSessionId — used as part of the cache key so the chip
   *  re-fetches when the session changes (workspace restarts, forks, etc.). */
  claudeSessionId: string | null
}

function ModelContextChip({
  workspaceId,
  claudeSessionId
}: ModelContextChipProps): React.JSX.Element | null {
  const cacheKey = `${workspaceId}:${claudeSessionId ?? ''}`
  const cached = contextBudgetCache.get(cacheKey) ?? null
  const [info, setInfo] = useState<ContextBudgetInfo | null>(cached)
  const [usage, setUsage] = useState<SessionUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    const key = `${workspaceId}:${claudeSessionId ?? ''}`

    // Serve cache immediately; still revalidate so the chip stays fresh after
    // a session's first message (context budget updates as tokens are used).
    const stale = contextBudgetCache.get(key)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: seed chip from cache on workspace/session change before async result arrives
    if (stale) setInfo(stale)

    window.api.sessions
      .getContextBudget(workspaceId)
      .then((result) => {
        if (!cancelled && result) {
          // Skip caching for pre-session workspaces (claudeSessionId === null)
          // so a stale model chip isn't shown after a global model change.
          if (claudeSessionId !== null) {
            contextBudgetCache.set(key, result)
          }
          setInfo(result)
        }
      })
      .catch(() => {})

    window.api.actions
      .invoke({ id: 'session.getUsage', params: {}, workspaceId }, 'workspace-context')
      .then((result) => {
        if (!cancelled && result.ok && result.value != null) {
          setUsage(result.value as SessionUsage)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [workspaceId, claudeSessionId])

  if (!info) return null

  // Show only the model + total context budget (e.g. "Opus 4.8 · 1M").
  // The used-context count lives in the hover tooltip, not the always-visible chip.
  const label = `${modelLabel(info.modelId)} · ${shortTokens(info.contextBudget)}`

  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-text-muted bg-surface-overlay border border-border-default/50 rounded px-1.5 py-0.5 flex-shrink-0 leading-none"
      title={
        usage
          ? `Context: ${usage.lastTurnContextTokens.toLocaleString()} / ${info.contextBudget.toLocaleString()} tokens (${Math.round(usage.usedPct)}%)`
          : `Model: ${info.modelId} · Context: ${info.contextBudget.toLocaleString()} tokens`
      }
    >
      <Cpu size={10} className="flex-shrink-0 opacity-60" />
      <span>{label}</span>
    </span>
  )
}

interface WorkspaceTitleBarProps {
  workspace: WorkspaceRecord
  drawer: null | 'status' | 'overrides'
  onSetDrawer: (drawer: null | 'status' | 'overrides') => void
  pr?: GhPullRequest | null
  /** All workspaces — used to resolve the parent workspace name for forked-from chip. */
  allWorkspaces?: WorkspaceRecord[]
}

export function WorkspaceTitleBar({
  workspace,
  drawer,
  onSetDrawer,
  pr,
  allWorkspaces
}: WorkspaceTitleBarProps): React.JSX.Element {
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null)
  const detailsButtonRef = useRef<HTMLButtonElement>(null)
  const detailsHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Git status for the details popover
  const gitStatus = useGitStatus(workspace.id)

  useEffect(() => {
    const workspaceId = workspace.id
    let cancelled = false
    window.api.workspaces
      .getTitle(workspaceId)
      .then((t) => {
        if (!cancelled) setTerminalTitle(t)
      })
      .catch(() => {})
    const unsub = window.api.workspaces.onTitleChanged((e) => {
      if (e.workspaceId === workspaceId) setTerminalTitle(e.title || null)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [workspace.id])

  // ── Details popover — hover open/close + async data fetching ────────────────

  function clearDetailsHoverTimer(): void {
    if (detailsHoverTimerRef.current !== null) {
      clearTimeout(detailsHoverTimerRef.current)
      detailsHoverTimerRef.current = null
    }
  }

  function openDetailsPopover(): void {
    if (!detailsButtonRef.current) return

    // Build initial data with whatever is synchronously available.
    // For worktree workspaces, enrich the cwd line with the parent repo path
    // so the Details popover surfaces both the worktree location and its parent.
    const cwdDisplay = workspace.worktreeParentCwd
      ? `${workspace.worktreeParentCwd}\n↳ worktree: ${workspace.cwd}`
      : workspace.cwd
    const initialData: DetailsPopoverData = {
      pr: prToNative(pr ?? null),
      git: gitStatus ? gitStatusToNative(gitStatus) : undefined,
      cwd: cwdDisplay,
      contextLoading: true,
      costLoading: true
    }
    showDetailsPopover(workspace.id, detailsButtonRef.current, initialData, pr ?? null)

    // ── Async: context budget ────────────────────────────────────────────────
    const cacheKey = `${workspace.id}:${workspace.claudeSessionId ?? ''}`
    const cached = contextBudgetCache.get(cacheKey)
    if (cached) {
      updateDetailsPopover(workspace.id, {
        model: modelLabel(cached.modelId),
        contextLoading: false
      })
    }

    window.api.sessions
      .getContextBudget(workspace.id)
      .then((result) => {
        if (!result) return
        if (workspace.claudeSessionId !== null) {
          contextBudgetCache.set(cacheKey, result)
        }
        // Fetch usage too so we can compose "1.2k / 200k · 85%"
        return window.api.actions
          .invoke(
            { id: 'session.getUsage', params: {}, workspaceId: workspace.id },
            'workspace-context'
          )
          .then((usageResult) => {
            const usage =
              usageResult.ok && usageResult.value != null
                ? (usageResult.value as SessionUsage)
                : null
            const ctxText = usage
              ? `${shortTokens(usage.lastTurnContextTokens)} / ${shortTokens(result.contextBudget)} · ${Math.round(usage.usedPct)}%`
              : shortTokens(result.contextBudget)
            updateDetailsPopover(workspace.id, {
              model: modelLabel(result.modelId),
              contextText: ctxText,
              contextLoading: false
            })
          })
      })
      .catch(() => {
        updateDetailsPopover(workspace.id, { contextLoading: false })
      })

    // ── Async: cost ──────────────────────────────────────────────────────────
    window.api.actions
      .invoke({ id: 'session.getCost', params: {}, workspaceId: workspace.id }, 'workspace-details')
      .then((result) => {
        if (result.ok && result.value != null) {
          const cost = result.value as SessionCost
          updateDetailsPopover(workspace.id, {
            cost: `$${cost.usd.toFixed(2)}`,
            costLoading: false
          })
        } else {
          updateDetailsPopover(workspace.id, { costLoading: false })
        }
      })
      .catch(() => {
        updateDetailsPopover(workspace.id, { costLoading: false })
      })
  }

  function handleDetailsMouseEnter(): void {
    clearDetailsHoverTimer()
    detailsHoverTimerRef.current = setTimeout(() => {
      detailsHoverTimerRef.current = null
      openDetailsPopover()
    }, 120)
  }

  function handleDetailsMouseLeave(): void {
    clearDetailsHoverTimer()
    detailsHoverTimerRef.current = setTimeout(() => {
      detailsHoverTimerRef.current = null
      hideNativePopover(workspace.id)
    }, 80)
  }

  // Hide and cancel timers on workspace change or unmount
  useEffect(() => {
    return () => {
      clearDetailsHoverTimer()
      hideNativePopover(workspace.id)
    }
  }, [workspace.id])

  // Hover-bridge: when the native card closes itself via NSTrackingArea
  // mouseExited (pointer left the card without returning to the trigger),
  // reset our open-state by cancelling any pending timers. This ensures a
  // subsequent hover on the Details button re-opens the card cleanly.
  useEffect(() => {
    const unregister = onNativePopoverClosed(workspace.id, () => {
      clearDetailsHoverTimer()
    })
    return unregister
  }, [workspace.id])

  // Resolve parent name for the "forked from" chip
  const forkedFromSessionId = workspace.forkedFromSessionId ?? null
  let forkedFromName: string | null = null
  if (forkedFromSessionId && allWorkspaces) {
    const parent = allWorkspaces.find((w) => w.claudeSessionId === forkedFromSessionId)
    forkedFromName = parent ? parent.name : null
  }

  return (
    <div
      className="flex items-center gap-2 min-w-0 flex-1 px-3"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <TerminalIcon size={13} className="text-text-muted flex-shrink-0" />
      <span
        className="text-xs font-medium text-text-primary truncate"
        title={
          workspace.nameIsAuto && terminalTitle && terminalTitle !== workspace.name
            ? `${workspace.name} — ${terminalTitle}`
            : workspace.name
        }
      >
        {workspace.nameIsAuto ? terminalTitle || workspace.name : workspace.name}
      </span>

      {/* PR chip appears next to the workspace name when the current branch
          has a PR on GitHub. Hides cleanly when no PR. */}
      {pr && (
        <span className="flex-shrink-0">
          <PrChip pr={pr} variant="chip" />
        </span>
      )}

      {/* Forked-from chip — shown when this workspace was forked from another session */}
      {forkedFromSessionId && (
        <span
          className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-muted bg-surface-overlay/50 border border-border-default/40"
          title={
            forkedFromName ? `Forked from: ${forkedFromName}` : 'Forked from another workspace'
          }
        >
          <ArrowBendUpLeft size={9} className="flex-shrink-0" />
          {forkedFromName ? `forked from ${forkedFromName}` : 'forked'}
        </span>
      )}

      {/* Worktree chip — shown when this workspace is a git worktree */}
      {workspace.worktreeParentCwd && (
        <span
          className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-muted bg-surface-overlay/50 border border-border-default/40"
          title={`Worktree branch: ${workspace.worktreeBranch ?? 'unknown'}\nParent repo: ${workspace.worktreeParentCwd}`}
        >
          <GitBranch size={9} className="flex-shrink-0" />
          {`Worktree · ${workspace.worktreeBranch ?? 'worktree'}`}
        </span>
      )}

      {/* Model + context chip — read-only, fetched from main via IPC */}
      <ModelContextChip workspaceId={workspace.id} claudeSessionId={workspace.claudeSessionId} />

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          ref={detailsButtonRef}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={handleDetailsMouseEnter}
          onMouseLeave={handleDetailsMouseLeave}
          title="Details"
          aria-label="Details"
          className={[
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0',
            'transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
          ].join(' ')}
        >
          <Info size={14} />
          <span>Details</span>
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onSetDrawer(drawer === 'overrides' ? null : 'overrides')}
          title="Workspace Settings"
          aria-label="Workspace Settings"
          className={[
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0',
            'transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            drawer === 'overrides'
              ? 'bg-surface-overlay text-text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
          ].join(' ')}
        >
          <Gear size={14} />
          <span>Workspace Settings</span>
        </button>
      </div>
    </div>
  )
}
