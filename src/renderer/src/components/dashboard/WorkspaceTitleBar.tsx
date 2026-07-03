import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  Terminal as TerminalIcon,
  Gear,
  ArrowBendUpLeft,
  Info,
  GitBranch,
  SquaresFour,
  CaretLeft
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
import { ClaudeGlyph } from '../workbench/ClaudeGlyph'
import { useWorkbenchApi } from '../workbench/workbenchReducer'

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
  /** Workbench feature flag (U2/U3, docs/plans/2026-07-02-001-feat-workbench-panes-plan.md).
   *  When false (default) this component renders byte-for-byte as it did before U3 —
   *  terminal icon, separate Details button, Gear "Workspace Settings" button.
   *  When true it renders the three-section layout: Claude glyph, title-hover
   *  details (dirty chip included), no gear, and a "Workbench" button stub. */
  workbenchEnabled?: boolean
  /** Restarts the workspace to apply pending settings changes — same handler
   *  WorkspaceDrawer's "Restart to apply" button uses. Only consulted on the
   *  workbenchEnabled path, where the dirty chip re-homes into the details
   *  popover instead of the (removed) gear's drawer. */
  onRestart?: () => void
}

export function WorkspaceTitleBar({
  workspace,
  drawer,
  onSetDrawer,
  pr,
  allWorkspaces,
  workbenchEnabled = false,
  onRestart
}: WorkspaceTitleBarProps): React.JSX.Element {
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null)
  const detailsButtonRef = useRef<HTMLElement>(null)
  // Hover timing mirrors the old floating-ui delays: 120ms open, 80ms close.
  const hoverCard = useOverlayHoverCard({ openDelay: 120, closeDelay: 80 })
  // U4 — the shared Workbench state machine. Only actually provided (non-null)
  // when workbenchEnabled, via WorkbenchProvider in WorkspaceView; safe to
  // call unconditionally (reads a context that's null on the flag-off path).
  const workbenchApi = useWorkbenchApi()

  // Git status for the details popover
  const gitStatus = useGitStatus(workspace.id)

  // Dirty ("Restart to apply") state — only tracked/surfaced on the
  // workbenchEnabled path, where it re-homes into the title-hover details
  // popover instead of the (removed) gear's WorkspaceDrawer. Mirrors the
  // polling + push pattern WorkspaceDrawer uses for the same state.
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    if (!workbenchEnabled) return
    const workspaceId = workspace.id
    let cancelled = false
    window.api.workspaces
      .isDirty(workspaceId)
      .then((d) => {
        if (!cancelled) setIsDirty(d)
      })
      .catch(() => {
        if (!cancelled) setIsDirty(false)
      })
    const unsub = window.api.workspaces.onDirtyChanged((e) => {
      if (e.workspaceId === workspaceId) setIsDirty(e.dirty)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [workbenchEnabled, workspace.id])

  // Keep the open details popover's dirty chip in sync if isDirty changes
  // while the popover is already showing.
  useEffect(() => {
    if (!workbenchEnabled) return
    updateDetailsCard(detailsCardId(workspace.id), { isDirty })
  }, [isDirty, workbenchEnabled, workspace.id])

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
      costLoading: true,
      // Dirty/"Restart to apply" only ever surfaces here on the
      // workbenchEnabled path (U3) — isDirty stays false/unset otherwise.
      isDirty: workbenchEnabled ? isDirty : undefined
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
  // close timer on enter and re-arm it (same 80ms) on leave. Also registers
  // the "Restart to apply" click the card emits (workbenchEnabled path only,
  // U3) — the dirty chip re-homes here since the gear/drawer is removed.
  useEffect(() => {
    const unregister = onCardPointer(detailsCardId(workspace.id), {
      onEnter: hoverCard.clearTimer,
      onLeave: () => hoverCard.armClose(hideDetailsCard),
      onRestart: workbenchEnabled ? () => onRestart?.() : undefined
    })
    return unregister
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, workbenchEnabled, onRestart])

  // Resolve parent name for the "forked from" chip
  const forkedFromSessionId = workspace.forkedFromSessionId ?? null
  let forkedFromName: string | null = null
  if (forkedFromSessionId && allWorkspaces) {
    const parent = allWorkspaces.find((w) => w.claudeSessionId === forkedFromSessionId)
    forkedFromName = parent ? parent.name : null
  }

  const titleText = workspace.nameIsAuto ? terminalTitle || workspace.name : workspace.name
  const titleTooltip =
    workspace.nameIsAuto && terminalTitle && terminalTitle !== workspace.name
      ? `${workspace.name} — ${terminalTitle}`
      : workspace.name

  // Shared "extra chips" (PR / forked-from / worktree) — identical on both
  // the flag-off and flag-on paths.
  const chips = (
    <>
      {pr && (
        <span className="flex-shrink-0">
          <PrChip pr={pr} variant="chip" />
        </span>
      )}
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
      {workspace.worktreeParentCwd && (
        <span
          className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-muted bg-surface-overlay/50 border border-border-default/40"
          title={`Worktree branch: ${workspace.worktreeBranch ?? 'unknown'}\nParent repo: ${workspace.worktreeParentCwd}`}
        >
          <GitBranch size={9} className="flex-shrink-0" />
          {`Worktree · ${workspace.worktreeBranch ?? 'worktree'}`}
        </span>
      )}
    </>
  )

  // ── Flag ON — three-section layout ──────────────────────────────────────
  // Section 1 (icons over the sidebar) lives in TopBar itself; this
  // component only ever renders sections 2 (title, over Claude) + 3 (the
  // Workbench button, over the Workbench frame). Details moves to title
  // hover; the gear + its drawer trigger are removed entirely.
  if (workbenchEnabled) {
    // Section 2 becomes the "◂ Claude" restore control while the Workbench
    // is expanded (docs/brainstorms/2026-07-02-workbench-panes-requirements.md
    // §4) — clicking it is one of the two ways to land back in 'open'
    // (mirrors the ⤡ toggle in WorkbenchPanel's header).
    const isExpanded = workbenchApi?.state === 'expanded'

    return (
      <div
        className="flex items-center gap-2 min-w-0 flex-1 px-3"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {isExpanded ? (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => workbenchApi?.restoreToOpen()}
            title="Restore Claude"
            aria-label="Restore Claude"
            className={[
              'flex items-center gap-1.5 px-1.5 py-0.5 -mx-1.5 rounded-sm text-xs font-medium flex-shrink-0',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
              'text-accent hover:bg-surface-overlay/60'
            ].join(' ')}
          >
            <CaretLeft size={12} />
            <span>Claude</span>
          </button>
        ) : (
          <>
            <ClaudeGlyph size={13} className="text-text-muted flex-shrink-0" />
            <span
              ref={detailsButtonRef}
              tabIndex={0}
              role="button"
              aria-label={`Details for ${titleText}`}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseEnter={handleDetailsMouseEnter}
              onMouseLeave={handleDetailsMouseLeave}
              onFocus={handleDetailsMouseEnter}
              onBlur={handleDetailsMouseLeave}
              title={titleTooltip}
              className="text-xs font-medium text-text-primary truncate cursor-default rounded-sm hover:bg-surface-overlay/60 px-0.5 -mx-0.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              {titleText}
            </span>

            {chips}
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => workbenchApi?.toggle()}
            title="Workbench"
            aria-label="Workbench"
            aria-expanded={workbenchApi ? workbenchApi.state !== 'dormant' : false}
            className={[
              'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
              workbenchApi && workbenchApi.state !== 'dormant'
                ? 'bg-surface-overlay text-text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
            ].join(' ')}
          >
            <SquaresFour size={14} />
            <span>Workbench</span>
          </button>
        </div>
      </div>
    )
  }

  // ── Flag OFF (default) — unchanged from pre-U3 behavior ─────────────────
  return (
    <div
      className="flex items-center gap-2 min-w-0 flex-1 px-3"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <TerminalIcon size={13} className="text-text-muted flex-shrink-0" />
      <span className="text-xs font-medium text-text-primary truncate" title={titleTooltip}>
        {titleText}
      </span>

      {chips}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          ref={detailsButtonRef as React.Ref<HTMLButtonElement>}
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
