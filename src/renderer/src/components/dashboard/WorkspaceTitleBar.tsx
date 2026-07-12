import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  ArrowBendUpLeft,
  GitBranch,
  CaretLeft,
  ArrowsOutSimple,
  ArrowsInSimple,
  SquaresFour,
  X
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
import { useWorkbenchApi, type WorkbenchApi } from '../workbench/workbenchReducer'
import { WorkbenchTabStrip } from '../workbench/WorkbenchTabStrip'
import { DEFAULT_WORKBENCH_WIDTH } from '../../lib/workbenchStore'

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
// Workbench region of the top bar (right of the claude identity region).
// Extracted into its own component so WorkspaceTitleBar's render body stays
// under the cognitive-complexity ceiling — this holds the dormant-vs-open
// branch (opener button vs. tabs + ⤢/✕) plus all the per-control handlers.
// ---------------------------------------------------------------------------
interface WorkbenchTopBarRegionProps {
  api: WorkbenchApi
  style: React.CSSProperties
}

function WorkbenchTopBarRegion({ api, style }: WorkbenchTopBarRegionProps): React.JSX.Element {
  const isExpanded = api.state === 'expanded'
  const isDormant = api.state === 'dormant'

  // Focus continuity across the dormant<->open subtree swap: each of the
  // open()/close() handlers unmounts the very control the user activated
  // (the opener button, or the ✕), which would drop keyboard focus. We
  // remember that a KEYBOARD-driven transition just happened (the activated
  // element still had focus at click time) and, on the render that shows the
  // other subtree, move focus to a stable control there — the expand button
  // when opening, the reappeared opener button when closing. Mouse clicks
  // (activeElement is <body>) leave focus alone.
  const openerRef = useRef<HTMLButtonElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  // 'toOpen' = focus the expand control after opening; 'toDormant' = focus
  // the opener after closing; null = nothing pending (or a mouse click).
  const pendingFocusRef = useRef<'toOpen' | 'toDormant' | null>(null)

  function markKeyboardTransition(target: 'toOpen' | 'toDormant', el: HTMLElement): void {
    pendingFocusRef.current = document.activeElement === el ? target : null
  }

  useLayoutEffect(() => {
    const pending = pendingFocusRef.current
    if (!pending) return
    pendingFocusRef.current = null
    if (pending === 'toOpen' && !isDormant) expandRef.current?.focus()
    else if (pending === 'toDormant' && isDormant) openerRef.current?.focus()
  }, [isDormant])

  return (
    <div
      className={[
        'flex items-center gap-1 min-w-0 border-l border-border-default',
        isDormant ? 'pl-2 pr-3' : 'pl-2 pr-2'
      ].join(' ')}
      style={style}
    >
      {isDormant ? (
        <button
          ref={openerRef}
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            markKeyboardTransition('toOpen', e.currentTarget)
            api.open()
          }}
          title="Workbench"
          aria-label="Open Workbench"
          aria-expanded={false}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0 text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <SquaresFour size={14} />
          <span>Workbench</span>
        </button>
      ) : (
        <>
          <WorkbenchTabStrip activeTab={api.activeTab} onChange={api.selectTab} />
          <div className="flex items-center gap-1 flex-shrink-0 pl-2 border-l border-border-default">
            <button
              ref={expandRef}
              data-workbench-expand-toggle
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => api.toggleExpand()}
              aria-label={isExpanded ? 'Collapse Workbench' : 'Expand Workbench'}
              aria-expanded={isExpanded}
              title={isExpanded ? 'Collapse' : 'Expand'}
              className="flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              {isExpanded ? <ArrowsInSimple size={13} /> : <ArrowsOutSimple size={13} />}
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                markKeyboardTransition('toDormant', e.currentTarget)
                api.close()
              }}
              aria-label="Close Workbench"
              title="Close"
              className="flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              <X size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

interface WorkspaceTitleBarProps {
  workspace: WorkspaceRecord
  pr?: GhPullRequest | null
  /** All workspaces — used to resolve the parent workspace name for forked-from chip. */
  allWorkspaces?: WorkspaceRecord[]
  /** Restarts the workspace to apply pending settings changes — same handler
   *  WorkspaceDrawer's (preserved, no longer mounted) "Restart to apply" button
   *  used. The dirty chip re-homes into the title-hover details popover. */
  onRestart?: () => void
}

export function WorkspaceTitleBar({
  workspace,
  pr,
  allWorkspaces,
  onRestart
}: WorkspaceTitleBarProps): React.JSX.Element {
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null)
  const detailsButtonRef = useRef<HTMLElement>(null)
  // Hover timing mirrors the old floating-ui delays: 120ms open, 80ms close.
  const hoverCard = useOverlayHoverCard({ openDelay: 120, closeDelay: 80 })
  // The shared Workbench state machine, provided via WorkbenchProvider in
  // WorkspaceView.
  const workbenchApi = useWorkbenchApi()

  // Git status for the details popover
  const gitStatus = useGitStatus(workspace.id)

  // Dirty ("Restart to apply") state — surfaced in the title-hover details
  // popover instead of the (removed) gear's WorkspaceDrawer. Mirrors the
  // polling + push pattern WorkspaceDrawer (preserved, no longer mounted)
  // uses for the same state.
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
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
  }, [workspace.id])

  // Keep the open details popover's dirty chip in sync if isDirty changes
  // while the popover is already showing.
  useEffect(() => {
    updateDetailsCard(detailsCardId(workspace.id), { isDirty })
  }, [isDirty, workspace.id])

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
      isDirty
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
  // the "Restart to apply" click the card emits — the dirty chip re-homes
  // here since the gear/drawer is removed.
  useEffect(() => {
    const unregister = onCardPointer(detailsCardId(workspace.id), {
      onEnter: hoverCard.clearTimer,
      onLeave: () => hoverCard.armClose(hideDetailsCard),
      onRestart: () => onRestart?.()
    })
    return unregister
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, onRestart])

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

  // "Extra chips" (PR / forked-from / worktree).
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

  // ── Two-region layout (U9) ───────────────────────────────────────────────
  // Section 1 (icons over the sidebar) lives in TopBar itself; this
  // component renders the rest of the bar as TWO regions that mirror the
  // body's own claude-column/Workbench-frame split exactly:
  //
  //   - claude region  (left):  [icon or ◂][title][chips] — always shows the
  //     icon+title; never clickable as a "restore" control itself. Sized
  //     `flex-1` in 'open'/'dormant' (matches `data-workbench-claude-column`
  //     below), shrunk to just [icon/◂][title] (chips dropped) in 'expanded'
  //     so the region doesn't fight the workbench region for space once the
  //     claude column itself is 0-width in the body.
  //   - workbench region (right): renders CONDITIONALLY on state —
  //       • dormant        → a single [Workbench] opener button (NO tabs, no
  //         ⤢/✕). Clicking it opens the Workbench (restoring lastMode via
  //         `open()`), at which point this button is replaced by the tabs +
  //         controls below.
  //       • open|expanded  → [Git/Terminal/Files/Panes tabs][⤢][✕].
  //     While open/expanded its width is driven by the SAME value the body's
  //     WorkbenchPanel uses for its own width (`workbenchApi.width` while
  //     'open') — see `workbenchRegionStyle` below — so the vertical seam
  //     between the two top-bar regions lines up pixel-for-pixel with the
  //     seam between the claude column and the Workbench frame beneath it. In
  //     'expanded' the workbench region takes the REMAINING width via `flex:1`
  //     (NOT `width:100%` — the top bar's claude region is still non-zero
  //     [◂]+title, so 100% would overflow the bar and push ⤢/✕ off-screen; the
  //     body frame can use 100% because its sibling claude column is 0-width);
  //     in 'dormant' there is no body-side frame to mirror, so the region just
  //     fits its opener button (auto width).
  //
  // ⤢/✕ moved here from WorkbenchPanel's header (U9) — WorkbenchPanel no
  // longer renders any header row of its own; per-content headers (e.g. the
  // Terminal tab's own TerminalStrip) now live inside the panel body.
  const state = workbenchApi?.state ?? 'dormant'
  const isExpanded = state === 'expanded'
  const isDormant = state === 'dormant'
  const workbenchWidth = workbenchApi?.width ?? DEFAULT_WORKBENCH_WIDTH

  // Focus continuity for the ◂ (Back to Claude) control: it only exists while
  // expanded, and clicking it collapses to 'open' — which unmounts ◂ and
  // swaps in the (non-focusable) ClaudeGlyph, dropping keyboard focus. When
  // the collapse was keyboard-driven, hand focus to the workbench region's
  // expand (⤢) toggle, which is present + focusable in 'open' (queried by a
  // stable data attribute so the parent stays decoupled from the child that
  // owns that button). Focusing the title span instead would spuriously open
  // its hover-details popover via onFocus, so ⤢ is the correct target.
  const backToClaudeRef = useRef<HTMLButtonElement>(null)
  const pendingCollapseFocusRef = useRef(false)
  useLayoutEffect(() => {
    if (isExpanded || !pendingCollapseFocusRef.current) return
    pendingCollapseFocusRef.current = false
    document.querySelector<HTMLButtonElement>('[data-workbench-expand-toggle]')?.focus()
  }, [isExpanded])

  // Mirrors WorkspaceView's `data-workbench-claude-column` (flex-1) +
  // WorkbenchPanel's own `style.width` (dormant: 0 / open: width / expanded:
  // '100%') — see that component's frame element for the body-side values
  // this must track exactly, including the same width transition (so the
  // top-bar seam and the body seam animate in lockstep) and the drag-time
  // transition suppression (matches WorkbenchPanel's `isDraggingDivider`
  // check — an active transition would visibly lag a fast drag).
  const workbenchRegionStyle: React.CSSProperties = isDormant
    ? {}
    : isExpanded
      ? {
          // Expanded: the claude region shrinks to just [◂]+title (flex-shrink-0),
          // so the workbench region takes the REMAINING width via flex:1 — NOT
          // width:100% (which, combined with the non-zero claude region, would
          // overflow the bar and push the ⤢/✕ controls off-screen). The body
          // frame uses width:100% because its sibling claude column is 0-width;
          // the top bar's claude region is not, so flex:1 is the correct mirror.
          flex: '1 1 0%',
          minWidth: 0,
          transition: workbenchApi?.isDraggingDivider ? 'none' : 'width 200ms ease'
        }
      : {
          width: workbenchWidth,
          flexShrink: 0,
          transition: workbenchApi?.isDraggingDivider ? 'none' : 'width 200ms ease'
        }

  return (
    <div
      className="flex items-stretch min-w-0 flex-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Claude region — mirrors data-workbench-claude-column (flex-1) */}
      <div
        className={[
          'flex items-center gap-2 min-w-0 px-3',
          isExpanded ? 'flex-shrink-0' : 'flex-1'
        ].join(' ')}
      >
        {isExpanded ? (
          <button
            ref={backToClaudeRef}
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              pendingCollapseFocusRef.current = document.activeElement === e.currentTarget
              workbenchApi?.restoreToOpen()
            }}
            title="Back to Claude"
            aria-label="Back to Claude"
            className="flex items-center justify-center w-5 h-5 -ml-0.5 rounded-sm text-text-muted hover:text-text-primary hover:bg-surface-overlay/60 transition-colors duration-150 flex-shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <CaretLeft size={13} />
          </button>
        ) : (
          <ClaudeGlyph size={13} className="text-text-muted flex-shrink-0" />
        )}

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

        {!isExpanded && chips}
      </div>

      {/* Workbench region — dormant shows only a [Workbench] opener button;
          open/expanded shows the section tabs + ⤢/✕ and mirrors
          WorkbenchPanel's frame width exactly (see workbenchRegionStyle).
          Extracted to WorkbenchTopBarRegion; only rendered when the shared
          api exists (it always does inside WorkbenchProvider, but the hook
          is nullable). */}
      {workbenchApi && <WorkbenchTopBarRegion api={workbenchApi} style={workbenchRegionStyle} />}
    </div>
  )
}
