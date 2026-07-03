import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  Terminal as TerminalIcon,
  Gear,
  ArrowBendUpLeft,
  Info,
  GitBranch
} from '@phosphor-icons/react'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'
import type { GhPullRequest, WorkspaceRecord, SessionUsage, SessionCost } from '@shared/types'
import { PrChip } from '../github/PrChip'
import { useGitStatus } from '@/lib/gitStore'
import { useOverlayHoverCard } from '@/lib/useOverlayHoverCard'
import {
  showDetailsCard,
  updateDetailsCard,
  hideOverlayCard,
  detailsCardId,
  onCardPointer,
  gitStatusToCard,
  prToCard
} from '@/lib/overlayClient'
import type { DetailsCardProps } from '@shared/types'
import { contextBudgetCache } from './workspaceTitleBar.helpers'

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
  // Hover timing mirrors the old floating-ui delays: 120ms open, 80ms close.
  const hoverCard = useOverlayHoverCard({ openDelay: 120, closeDelay: 80 })

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

  function updateDetails(patch: Partial<DetailsCardProps>): void {
    updateDetailsCard(detailsCardId(workspace.id), patch)
  }

  function hideDetailsCard(): void {
    hideOverlayCard(detailsCardId(workspace.id))
  }

  function openDetailsPopover(): void {
    if (!detailsButtonRef.current) return

    // Build initial data with whatever is synchronously available.
    // For worktree workspaces, enrich the cwd line with the parent repo path
    // so the Details popover surfaces both the worktree location and its parent.
    const cwdDisplay = workspace.worktreeParentCwd
      ? `${workspace.worktreeParentCwd}\n↳ worktree: ${workspace.cwd}`
      : workspace.cwd

    const initialProps: DetailsCardProps = {
      pr: prToCard(pr ?? null),
      git: gitStatus ? gitStatusToCard(gitStatus) : undefined,
      cwd: cwdDisplay,
      contextLoading: true,
      costLoading: true
    }
    showDetailsCard(workspace.id, detailsButtonRef.current, initialProps)

    // ── Async: context budget ────────────────────────────────────────────────
    const cacheKey = `${workspace.id}:${workspace.claudeSessionId ?? ''}`
    const cached = contextBudgetCache.get(cacheKey)
    if (cached) {
      updateDetails({
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
            updateDetails({
              model: modelLabel(result.modelId),
              contextText: ctxText,
              contextLoading: false
            })
          })
      })
      .catch(() => {
        updateDetails({ contextLoading: false })
      })

    // ── Async: cost ──────────────────────────────────────────────────────────
    window.api.actions
      .invoke({ id: 'session.getCost', params: {}, workspaceId: workspace.id }, 'workspace-details')
      .then((result) => {
        if (result.ok && result.value != null) {
          const cost = result.value as SessionCost
          updateDetails({
            cost: `$${cost.usd.toFixed(2)}`,
            costLoading: false
          })
        } else {
          updateDetails({ costLoading: false })
        }
      })
      .catch(() => {
        updateDetails({ costLoading: false })
      })
  }

  function handleDetailsMouseEnter(): void {
    hoverCard.handleMouseEnter(openDetailsPopover)
  }

  function handleDetailsMouseLeave(): void {
    hoverCard.handleMouseLeave(hideDetailsCard)
  }

  // Hide and cancel timers on workspace change or unmount
  useEffect(() => {
    return () => {
      hoverCard.clearTimer()
      hideDetailsCard()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id])

  // Hover-bridge: keep the card open while the pointer is over the card
  // itself — the overlay card emits mouseenter/mouseleave, so cancel the
  // close timer on enter and re-arm it (same 80ms) on leave.
  useEffect(() => {
    const unregister = onCardPointer(detailsCardId(workspace.id), {
      onEnter: hoverCard.clearTimer,
      onLeave: () => hoverCard.armClose(hideDetailsCard)
    })
    return unregister
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
