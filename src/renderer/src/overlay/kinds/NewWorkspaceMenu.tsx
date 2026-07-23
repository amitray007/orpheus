import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaretRight, GitBranch, House, ArrowElbowDownLeft, SpinnerGap } from '@phosphor-icons/react'
import type { NewWorkspaceMenuProps } from '@shared/types'
import type { OverlayKindProps } from '../registry'
import { ProviderIcon } from '../../components/ProviderIcon'
import { RefreshModelsButton } from '../../components/RefreshModelsButton'
import { labelFor } from '../../lib/modelPickerOptions'
import {
  computeSubmenuSide,
  reduceRowHover,
  type HoveredRow
} from '../../lib/newWorkspaceMenuLogic'
import { useGenuineHoverGate } from '../../lib/useGenuineHoverGate'

// ---------------------------------------------------------------------------
// Phantom-hover guard (the "popover flickers open/closed on its own" bug —
// root-caused via runtime instrumentation, not guessed): this overlay kind is
// the ONLY one whose card size changes as a DIRECT consequence of a hover
// handler (hovering a provider row opens a same-window flyout submenu, which
// grows the CARD, which grows the host BrowserWindow via
// OverlayRoot's ResizeObserver -> reportSize -> overlayLayer's setBounds).
// The window starts at a generous DEFAULT_ANCHORED guess (440x380) and then
// shrinks/grows several times as the real card size is measured and as
// submenus open/close. Every one of those resizes moves the WINDOW under
// whatever the OS mouse cursor is currently resting on (the cursor never
// itself moves) — Chromium then delivers a perfectly genuine, but spurious,
// native mouseenter/mouseleave for that transition, which this component
// previously treated identically to a real user-driven hover. That fired
// openSubmenuFor for whatever row/panel the resize happened to leave under
// the stationary cursor, growing the window AGAIN, moving a DIFFERENT
// element under the cursor, and so on — an observed self-sustaining
// open/close/reassign-to-a-different-provider loop with no real input at
// all, and the mechanism behind the reported "I saw it for a split second
// and then it's gone" (proven live: hovering it via a debug harness with the
// popover left open and no attached input showed hoverProvider firing
// repeatedly for codex/xai/antigravity/claude in turn purely off the
// window's own resizes).
//
// Fix: distinguish a genuine hover (preceded by an actual mousemove since the
// window's last resize) from a resize-driven phantom one (cursor stationary
// since the last resize) — only the former is allowed to reach onHover/
// previewSubmenuFor. `hasMovedRef` is armed by a real mousemove and cleared back
// to false by the window's own 'resize' event (fired whenever overlayLayer's
// setBounds changes this BrowserWindow's size — the exact signal this bug is
// chasing). A mouseenter is trusted only when hasMovedRef is true.
//
// The hook itself (useGenuineHoverGate) now lives in
// ../../lib/useGenuineHoverGate.ts, shared with ChipGroupedDropdown.tsx (the
// footer Model chip's own provider -> model flyout, which resizes its card
// for the exact same reason and hit the exact same phantom-hover mechanism)
// — imported above rather than redefined here, so this fix has exactly one
// implementation instead of drifting across two copies.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NewWorkspaceMenu (overlay kind) — dumb render + emit, ported off the
// in-page `Overlay` component (model-routing unit 10-creation) so the "+ new
// workspace" popover paints OVER the terminal instead of being clipped
// inside the sidebar. Mirrors WorkspaceSettingsCard.tsx's contract exactly:
// props down (a pure serializable snapshot the call site recomputes on every
// state change), events up (emit() — the call site owns every window.api.*
// call and turns each event into a hook call + updateNewWorkspaceMenu push).
//
// Inverted create-flow (the approved redesign): the top line (provider icon +
// selected model name + an Enter-key affordance) is the SOLE create action —
// clicking it or pressing Enter emits 'create'. Local/Worktree are a
// two-way isolation TOGGLE only (emits 'pickIsolation'), never a create
// action themselves. Selecting Worktree reveals the branch field inline;
// creating from the top line while Worktree is selected uses whatever branch
// text is currently in that field (validated by the call site, which owns
// the debounced worktrees.branchExists check and the actual
// workspaces.createWorktree call).
//
// PROVIDER -> MODEL FLYOUT SUBMENU (this unit's redesign — was an in-place
// swap, hiding the provider list and losing the user's place; the standard
// hierarchical-menu pattern macOS menus/VS Code/any nested context menu use
// instead is what this component now implements):
//   - The parent panel (provider rows) NEVER unmounts while the popover is
//     open — no more `view === 'providers' ? groups : activeGroup.models`
//     swap. `view` is now purely "which panel currently has KEYBOARD FOCUS"
//     (ArrowLeft/ArrowRight/Enter move focus between panels), not "which
//     panel is rendered".
//   - Hovering (or clicking, or ArrowRight/Enter on) a provider row opens a
//     SECOND PANEL rendered beside the parent. Hovering a DIFFERENT provider
//     row switches the submenu to that provider immediately.
//   - BOTH panels are laid out as IN-FLOW flex siblings (a flex row), not
//     one `position: absolute` over the other. This is deliberate: the
//     overlay window (src/main/overlayLayer.ts) sizes itself to whatever the
//     renderer's ResizeObserver reports for the outer `width: max-content`
//     card (OverlayRoot.tsx) — an out-of-flow absolutely-positioned
//     descendant does NOT contribute to that max-content measurement, so a
//     `position: absolute` submenu would get silently clipped by a window
//     sized to the parent panel alone. An in-flow flex child has no such
//     problem: the card's natural width is simply "parent panel + gap +
//     submenu", exactly like any adjacent-menu layout, and needs no manual
//     spacer/extent-reservation hack. The LEFT/RIGHT flip (see
//     computeSubmenuSide) is implemented as a flex `order` swap — the
//     submenu renders as flex item 0 (visually left) or flex item 2
//     (visually right) of the same row, so it's always in-flow regardless
//     of which side it's on.
//   - This panel lives in the SAME overlay surface/window as the parent
//     panel (not a second overlay window): the existing overlay
//     infrastructure (src/main/overlayLayer.ts) shows exactly one descriptor
//     at a time (showOverlay() replaces whatever's current) — a second
//     floating panel in the SAME React tree needs no new IPC, no second
//     paint-ack handshake, and no second cross-window pointer boundary,
//     which a second overlay WINDOW would require. Diagonal traversal
//     (moving the pointer from the row toward the submenu) is solved the
//     same way every other hover-driven overlay in this app solves the
//     anchor-to-card gap (Sidebar's HoverCard, WorkspaceTitleBar's
//     DetailsCard, and this same popover's own now-removed trigger-hover
//     fix): a close-delay timer arms on leaving a row/the submenu, cancelled
//     the instant the pointer reaches ANY provider row or the submenu
//     itself — see the call site (NewWorkspaceMenu.tsx, the "smart" half)'s
//     onCardPointer wiring, now scoped to the submenu instead of the
//     top-level trigger.
// ---------------------------------------------------------------------------

function ProviderRow({
  providerId,
  label,
  modelCount,
  highlighted,
  hasSubmenuOpen,
  onHover,
  onLeave,
  onClick
}: {
  providerId: string
  label: string
  modelCount: number
  highlighted: boolean
  hasSubmenuOpen: boolean
  onHover: () => void
  onLeave: () => void
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={hasSubmenuOpen}
      onPointerEnter={onHover}
      onPointerLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={[
        // NOTE: deliberately NO CSS `hover:` pseudo-class here (see this
        // file's header comment on the "three rows stuck highlighted" bug —
        // `:hover` is evaluated off live window/cursor geometry and
        // completely bypasses the genuine-hover gate, so it can leave
        // multiple rows painted across this popover's own resize-driven
        // window moves). The highlight is ENTIRELY JS-driven now: `highlighted`
        // (one boolean, sourced from the single `hoveredRow`/`highlighted`
        // state in the parent, gated through isGenuineHover before it's ever
        // set) is the only thing that can paint this row.
        'w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-text-primary transition-colors duration-100 focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer',
        highlighted || hasSubmenuOpen ? 'bg-surface-raised' : ''
      ].join(' ')}
    >
      <ProviderIcon providerId={providerId} size={13} />
      <span className="flex-1 truncate">{label}</span>
      <span className="text-xs text-text-muted flex-shrink-0">{modelCount}</span>
      <CaretRight size={11} className="text-text-muted flex-shrink-0" />
    </button>
  )
}

/** The top line — the SOLE create action (rule 4's inversion). Clicking it
 *  (or pressing Enter anywhere in the popover) creates immediately with the
 *  currently-selected model + isolation. Extracted from the main component
 *  to keep NewWorkspaceMenu's own cognitive complexity under the repo's
 *  ceiling. */
function TopLine({
  providerId,
  groupLabel,
  modelLabel,
  disabled,
  onCreate
}: {
  providerId: string
  groupLabel: string
  modelLabel: string
  disabled: boolean
  onCreate: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onCreate()
      }}
      disabled={disabled}
      className={[
        'w-full flex items-center gap-1.5 px-3 py-1.5 border-b border-border-default/60',
        'transition-colors duration-100 text-left',
        'focus-visible:outline-none focus-visible:bg-surface-raised',
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-raised cursor-pointer'
      ].join(' ')}
      title="Create workspace"
    >
      <ProviderIcon providerId={providerId} size={12} />
      <span className="flex-1 min-w-0 text-xs text-text-secondary truncate">
        {groupLabel}
        {modelLabel ? ` · ${modelLabel}` : ''}
      </span>
      <span
        className="flex-shrink-0 flex items-center justify-center text-text-muted bg-surface-default border border-border-default rounded px-1 py-0.5 leading-none"
        aria-hidden="true"
      >
        <ArrowElbowDownLeft size={10} />
      </span>
    </button>
  )
}

/** Local/Worktree isolation-mode selector row — a two-way TOGGLE only
 *  (never creates), matching rule 4's inversion. Extracted for the same
 *  cognitive-complexity reason as TopLine above. */
function IsolationRow({
  isolation,
  modes,
  onPick
}: {
  isolation: 'local' | 'worktree'
  modes?: { local: boolean; worktree: boolean }
  onPick: (isolation: 'local' | 'worktree') => void
}): React.JSX.Element {
  function classesFor(mode: 'local' | 'worktree', enabled: boolean): string {
    if (!enabled) return 'opacity-40 cursor-not-allowed border-border-default text-text-muted'
    if (isolation === mode) return 'bg-accent/15 border-accent/30 text-text-primary cursor-pointer'
    return 'border-border-default text-text-primary hover:bg-surface-raised cursor-pointer'
  }
  const localEnabled = modes ? modes.local : true
  const worktreeEnabled = modes ? modes.worktree : true
  const base =
    'flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-md border font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
  return (
    <div className="flex items-center gap-1.5 px-2 pt-1.5 mt-1 border-t border-border-default/60">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onPick('local')
        }}
        disabled={!localEnabled}
        aria-pressed={isolation === 'local'}
        className={[base, classesFor('local', localEnabled)].join(' ')}
      >
        <House size={12} weight="bold" />
        Local
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onPick('worktree')
        }}
        disabled={!worktreeEnabled}
        aria-pressed={isolation === 'worktree'}
        className={[base, classesFor('worktree', worktreeEnabled)].join(' ')}
      >
        <GitBranch size={12} />
        Worktree
      </button>
    </div>
  )
}

function BranchPanel({
  branchValue,
  branchExists,
  branchCreating,
  branchError,
  emit
}: {
  branchValue: string
  branchExists: boolean | null
  branchCreating: boolean
  branchError?: string
  emit: OverlayKindProps['emit']
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  const hint =
    branchExists === true
      ? 'branch exists — will check it out'
      : branchExists === false
        ? 'new branch'
        : null

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 border-t border-border-default/60">
      <div className="flex items-center gap-1.5">
        <GitBranch size={12} className="text-text-muted flex-shrink-0" />
        <span className="text-xs text-text-muted">Branch</span>
      </div>
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          type="text"
          value={branchValue}
          onChange={(e) => emit('changeBranch', { value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              emit('create')
            }
          }}
          disabled={branchCreating}
          placeholder="branch-name"
          aria-label="Branch name for worktree workspace"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className={[
            'w-full text-xs px-2 py-1.5 rounded-md border outline-none',
            'bg-surface-default text-text-primary placeholder:text-text-muted',
            branchCreating
              ? 'border-border-default opacity-60 cursor-not-allowed'
              : 'border-border-default focus:border-accent/60',
            branchError ? 'border-red-500/60' : ''
          ]
            .filter(Boolean)
            .join(' ')}
        />
        {branchCreating && (
          <span className="absolute right-2 text-text-muted animate-spin">
            <SpinnerGap size={12} />
          </span>
        )}
      </div>
      {hint && !branchError && <p className="text-xs text-text-muted leading-tight">{hint}</p>}
      {branchError && (
        <p className="text-xs text-red-400 leading-tight break-words">{branchError}</p>
      )}
    </div>
  )
}

/**
 * The active provider's model list, rendered as a FLYOUT SUBMENU beside the
 * parent panel — an IN-FLOW flex sibling (see this file's header comment for
 * why: an out-of-flow `position: absolute` panel wouldn't contribute to the
 * ancestor `width: max-content` card's intrinsic size, so the overlay
 * window's ResizeObserver-driven bounds would clip it). `order` (applied by
 * the parent) controls whether this renders visually left or right of the
 * provider list — the side flip is a pure CSS reorder, not a re-mount.
 */
function SubmenuPanel({
  activeGroup,
  isCommittedProvider,
  selectedModelId,
  activeGroupLastUsedId,
  highlighted,
  onPointerEnter,
  onPointerLeave,
  onRowHover,
  onRowLeave,
  onPickModel
}: {
  activeGroup: {
    providerId: string
    label: string
    models: NewWorkspaceMenuProps['groups'][number]['models']
  }
  /** True when this submenu's provider IS the committed top-line provider
   *  (selectedProviderId) — i.e. the user has actually picked into this
   *  provider, not merely hovered it. Gates which id the `●` marker follows:
   *  the committed selectedModelId when true, otherwise this provider's own
   *  last-used model as a PREVIEW ONLY (hovering must never read as if the
   *  hovered provider's model were already committed). */
  isCommittedProvider: boolean
  selectedModelId: string | undefined
  activeGroupLastUsedId: string | null
  highlighted: number
  /** Panel-level (not per-row) enter/leave — feeds the diagonal-traversal
   *  close-delay timer (enterSubmenu/leaveSubmenu), unrelated to which row
   *  is highlighted. */
  onPointerEnter: () => void
  onPointerLeave: () => void
  /** Per-row hover — drives the single JS-tracked `highlighted` index (see
   *  this file's header comment on the CSS `:hover` fix). Gated by the
   *  genuine-hover check at the call site before it ever updates state. */
  onRowHover: (idx: number) => void
  onRowLeave: (idx: number) => void
  onPickModel: (providerId: string, modelId: string) => void
}): React.JSX.Element {
  const dotModelId = isCommittedProvider
    ? (selectedModelId ?? activeGroupLastUsedId)
    : activeGroupLastUsedId
  return (
    <div
      role="menu"
      aria-label={`${activeGroup.label} models`}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className="w-64 flex-shrink-0 self-start rounded-md border border-border-default bg-surface-overlay shadow-lg py-1"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-muted border-b border-border-default/60">
        <ProviderIcon providerId={activeGroup.providerId} size={12} />
        <span className="flex-1 truncate">{activeGroup.label}</span>
      </div>
      {activeGroup.models.map((m, idx) => (
        <button
          key={m.id}
          type="button"
          role="menuitem"
          onPointerEnter={() => onRowHover(idx)}
          onPointerLeave={() => onRowLeave(idx)}
          onClick={(e) => {
            e.stopPropagation()
            onPickModel(activeGroup.providerId, m.id)
          }}
          className={[
            // No CSS `hover:` here either — same fix as ProviderRow above.
            'w-full flex items-center gap-2 pl-3 pr-3 py-1.5 text-sm text-left text-text-primary transition-colors duration-100 focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer',
            idx === highlighted ? 'bg-surface-raised' : ''
          ].join(' ')}
        >
          <span className="w-3 flex-shrink-0 text-accent">{m.id === dotModelId ? '●' : ''}</span>
          <span className="flex-1 truncate">{labelFor(m)}</span>
        </button>
      ))}
    </div>
  )
}

export function NewWorkspaceMenu({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as NewWorkspaceMenuProps
  const {
    loading,
    groups,
    view,
    activeProviderId,
    selectedProviderId,
    selectedModelId,
    isolation,
    modes,
    lastUsedModelIdByProvider,
    branchValue,
    branchExists,
    branchCreating,
    branchError,
    routingProxyEnabled,
    refreshState
  } = data

  // Local highlighted-row index for KEYBOARD nav within whichever panel has
  // focus (providers or, once a submenu is open, its models) — mirrors
  // ChipDropdown's own local highlighted-index pattern, EXCEPT this index is
  // never reset via an effect/ref (both forbidden by this repo's
  // react-hooks/set-state-in-effect and react-hooks/refs rules for
  // render-phase state adjustment). Instead `effectiveHighlighted` (below,
  // after `rows`/`activeGroup` are computed) derives a safe default straight
  // from props every render — the CURRENT selection's row index when
  // nothing has been explicitly hovered/arrow-key'd yet in this panel,
  // clamped to the live row count. Only explicit keyboard input (arrow keys)
  // calls setHighlighted now — MOUSE hover is tracked separately below
  // (hoveredRow) and merged into the same single displayed highlight in
  // effectiveHighlighted, so the two inputs converge on ONE row instead of
  // racing to paint two.
  const [highlighted, setHighlighted] = useState<number | null>(null)

  // Single JS-tracked mouse-hover row (the "three rows stuck highlighted"
  // fix — see reduceRowHover in newWorkspaceMenuLogic.ts and this file's
  // header comment). Exactly one HoveredRow value (or null) can ever exist
  // in state, which is what makes "at most one row highlighted" structurally
  // true rather than incidental: there is no per-row boolean a browser can
  // independently flip, only this one piece of state that every row's class
  // list reads back from.
  const [hoveredRow, setHoveredRow] = useState<HoveredRow>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const rowContainerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  // See the phantom-hover-guard comment at the top of this file — only a
  // hover preceded by a genuine mousemove (not the window's own resize) is
  // allowed to open/switch the submenu. The resize callback ALSO clears any
  // JS-tracked hovered row — the same event that revokes hover trust must
  // wipe a possibly-stale highlight, since a resize is exactly the moment a
  // row can be left highlighted with the cursor no longer over it.
  const hasGenuinelyMoved = useGenuineHoverGate(() => {
    setHoveredRow((current) => reduceRowHover({ type: 'clear' }, current))
  })

  const topLineProviderId = selectedProviderId ?? 'claude'
  const topLineGroup = groups.find((g) => g.providerId === topLineProviderId)
  const topLineModel = topLineGroup?.models.find((m) => m.id === selectedModelId)
  const topLineLabel = topLineModel ? labelFor(topLineModel) : (selectedModelId ?? '')

  const activeGroup = groups.find((g) => g.providerId === activeProviderId) ?? null
  const activeGroupLastUsedId = activeProviderId
    ? (lastUsedModelIdByProvider[activeProviderId] ?? null)
    : null

  // `rows` = whichever panel currently owns keyboard focus (`view`), used
  // only for arrow-key navigation bounds — BOTH panels are always rendered
  // once a submenu is open; `view` no longer decides what's mounted, only
  // which panel arrow keys/Enter act on.
  const rows = view === 'providers' ? groups : (activeGroup?.models ?? [])

  const defaultHighlighted =
    view === 'providers'
      ? Math.max(
          0,
          groups.findIndex((g) => g.providerId === (selectedProviderId ?? 'claude'))
        )
      : Math.max(
          0,
          (activeGroup?.models ?? []).findIndex((m) => m.id === selectedModelId)
        )

  // Mouse hover and keyboard highlight CONVERGE on this single value rather
  // than both painting independently: a genuine mouse hover on THIS panel
  // (hoveredRow.panel === view) wins over the keyboard index while it's
  // live; otherwise fall back to the keyboard-arrowed index; otherwise the
  // prop-derived default. Only one of these three ever supplies the
  // displayed index for a given render — never more than one row lit.
  const hoveredInThisPanel = hoveredRow && hoveredRow.panel === view ? hoveredRow.index : null
  const effectiveHighlighted =
    hoveredInThisPanel !== null && hoveredInThisPanel < rows.length
      ? hoveredInThisPanel
      : highlighted !== null && highlighted < rows.length
        ? highlighted
        : defaultHighlighted

  // ---------------------------------------------------------------------
  // Left/right flip — computeSubmenuSide only needs to know whether the
  // parent panel's own right edge has room for a same-width submenu on this
  // screen; that's measurable synchronously via getBoundingClientRect once
  // the parent panel has painted (it's a fixed w-64, so this is stable
  // across renders once mounted — recomputed on every activeProviderId
  // change in case the popover itself moved, e.g. main flipped the WHOLE
  // card to the opposite side of the trigger between opens).
  // ---------------------------------------------------------------------
  const [submenuSide, setSubmenuSide] = useState<'left' | 'right'>('right')
  useLayoutEffect(() => {
    if (!activeGroup) return
    const parentEl = rowContainerRef.current
    if (!parentEl) return
    const rect = parentEl.getBoundingClientRect()
    const side = computeSubmenuSide({
      parentPanelLeft: window.screenX + rect.left,
      parentPanelWidth: rect.width,
      submenuWidth: 256, // matches SubmenuPanel's w-64
      screenWidth: window.screen.availWidth,
      gap: 0 // panels now adjoin (gap-0 below) — no gutter to reserve fitment room for
    })
    setSubmenuSide(side)
  }, [activeGroup])

  function handleCreate(): void {
    emit('create')
  }

  /** PURELY NAVIGATIONAL — switches the flyout submenu to `providerId`'s
   *  model list (browsing) WITHOUT committing anything to the top line. Used
   *  by mouse hover and by ArrowUp/ArrowDown browsing through the provider
   *  list — neither is a deliberate "I want this provider" action, so
   *  neither may mutate the create payload (bug fix: hovering must never
   *  change the committed selection). The submenu still shows a preview
   *  highlight (SubmenuPanel falls back to `activeGroupLastUsedId` whenever
   *  the previewed provider isn't the committed `selectedProviderId`). */
  function previewSubmenuFor(providerId: string): void {
    // Switching which provider the flyout shows invalidates any hovered ROW
    // in the models panel — it belonged to the PREVIOUS provider's list, not
    // this one (requirement: "switching provider clears the previous
    // panel's hovered row"). The providers-panel hover itself is left alone
    // here; it's whatever row is driving this call in the first place.
    setHoveredRow((current) => (current && current.panel === 'models' ? null : current))
    emit('hoverProvider', { providerId })
  }

  /** EXPLICIT pick — a click, or ArrowRight/Enter navigating INTO a provider
   *  row. Unlike a hover, this IS deliberate: it both opens the submenu AND
   *  commits that provider's last-used model to the top line (mirrors
   *  onPickModel's own commit, just seeded from the provider's last-used
   *  model rather than an explicit model click). */
  function pickProviderRow(providerId: string): void {
    setHoveredRow((current) => (current && current.panel === 'models' ? null : current))
    emit('pickProvider', { providerId })
    const group = groups.find((g) => g.providerId === providerId)
    if (!group) return
    const modelId = group.models.some((m) => m.id === selectedModelId)
      ? selectedModelId
      : (lastUsedModelIdByProvider[providerId] ?? group.models[0]?.id)
    if (modelId) emit('pickModel', { providerId, modelId })
  }

  /** Moves the highlight to `index` within whichever panel currently has
   *  keyboard focus. In the providers panel this is BROWSING (preview only,
   *  see previewSubmenuFor) — arrow-key nav through provider rows must not
   *  commit anything, matching mouse-hover semantics; in the models panel a
   *  highlighted row IS the live selection (picking a model is itself a
   *  commit step, per onPickModel's own contract), so arrowing through
   *  models still applies immediately. */
  function selectRow(index: number): void {
    const clamped = Math.max(0, Math.min(rows.length - 1, index))
    setHighlighted(clamped)
    if (view === 'providers') {
      const group = groups[clamped]
      if (group) previewSubmenuFor(group.providerId)
    } else if (activeGroup) {
      const model = activeGroup.models[clamped]
      if (model) emit('pickModel', { providerId: activeGroup.providerId, modelId: model.id })
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      // ArrowLeft/Esc closes the submenu and returns focus to the parent row
      // when a submenu is open; Esc with no submenu open cancels the whole
      // popover (existing behavior).
      if (view === 'models') {
        setHighlighted(null)
        setHoveredRow(null)
        emit('backToProviders')
        return
      }
      setHoveredRow(null)
      emit('cancel')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectRow(effectiveHighlighted + 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectRow(effectiveHighlighted - 1)
      return
    }
    if (e.key === 'ArrowRight' && view === 'providers') {
      e.preventDefault()
      // ArrowRight is an explicit "enter this provider" action (matches a
      // click, not a hover) — commits its last-used model to the top line.
      const group = groups[effectiveHighlighted]
      if (group) {
        pickProviderRow(group.providerId)
        setHighlighted(0)
      }
      return
    }
    if (e.key === 'ArrowLeft' && view === 'models') {
      e.preventDefault()
      setHighlighted(null)
      setHoveredRow(null)
      emit('backToProviders')
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      // Enter always triggers the SAME create action as clicking the top
      // line — it never "confirms" a highlighted row, matching the approved
      // inversion (rows only ever select; only the top line/Enter creates).
      handleCreate()
    }
  }

  const parentPanel = (
    <div
      ref={rowContainerRef}
      className="w-64 flex-shrink-0 rounded-md border border-border-default bg-surface-overlay shadow-lg py-1"
    >
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted">
          <SpinnerGap size={12} className="animate-spin flex-shrink-0" />
          Loading…
        </div>
      ) : (
        <>
          <TopLine
            providerId={topLineProviderId}
            groupLabel={topLineGroup?.label ?? 'Claude'}
            modelLabel={topLineLabel}
            disabled={isolation === 'worktree' && !branchValue.trim()}
            onCreate={handleCreate}
          />

          {/* Provider list — the parent panel. ALWAYS rendered while the
              popover is open (never swapped out for the model list — that
              was the bug this unit fixes: it hid the other providers and
              lost the user's place). onMouseEnter/onMouseLeave on the LIST
              (not per-row) pairs with the submenu's own enter/leave below —
              together they're the two "safe" zones of the diagonal-
              traversal problem: the pointer leaving the row list arms a
              close timer at the call site UNLESS it lands on the submenu
              (which cancels it), exactly mirroring how leaving the submenu
              re-arms the same close the row list's leave would have. */}
          <div
            role="menu"
            onMouseEnter={() => {
              if (!hasGenuinelyMoved()) return
              emit('enterSubmenu')
            }}
            onMouseLeave={() => {
              if (!hasGenuinelyMoved()) return
              emit('leaveSubmenu')
            }}
          >
            {groups.map((group, idx) => (
              <ProviderRow
                key={group.providerId}
                providerId={group.providerId}
                label={group.label}
                modelCount={group.models.length}
                highlighted={view === 'providers' && idx === effectiveHighlighted}
                hasSubmenuOpen={activeProviderId === group.providerId}
                onHover={() => {
                  // Phantom-hover guard (see this file's header comment): a
                  // pointerenter fired by the window's OWN resize (submenu
                  // opening/closing moving this row under a stationary
                  // cursor), not a real user hover, must not open/reassign
                  // the submenu, and must not paint this row either —
                  // reduceRowHover's `genuine` gate is exactly this check,
                  // so a phantom enter leaves `hoveredRow` untouched. A
                  // genuine hover is still only NAVIGATIONAL
                  // (previewSubmenuFor, not pickProviderRow) — it must never
                  // commit anything to the top line.
                  const genuine = hasGenuinelyMoved()
                  setHoveredRow((current) =>
                    reduceRowHover(
                      { type: 'pointerEnter', panel: 'providers', index: idx, genuine },
                      current
                    )
                  )
                  if (!genuine) return
                  previewSubmenuFor(group.providerId)
                }}
                onLeave={() => {
                  setHoveredRow((current) =>
                    reduceRowHover(
                      { type: 'pointerLeave', panel: 'providers', index: idx },
                      current
                    )
                  )
                }}
                onClick={() => {
                  // An explicit click IS deliberate — commits this
                  // provider's last-used model to the top line.
                  setHighlighted(0)
                  setHoveredRow(null)
                  pickProviderRow(group.providerId)
                }}
              />
            ))}
          </div>

          {/* Pinned "Refresh models" row (model-routing unit 12) — placed
              ABOVE the Local/Worktree divider so it never collides with the
              isolation toggle/branch panel below it. Only shown when routing
              is actually enabled (a Claude-only provider list has nothing to
              refresh — RefreshModelsButton's own doc comment). `onRefresh`
              emits 'refresh' back to the call site
              (components/dashboard/NewWorkspaceMenu.tsx) — this component has
              no window.api access of its own (see RefreshModelsButton.tsx's
              own header comment). */}
          {routingProxyEnabled && (
            <div className="px-2 pt-1.5 mt-1 border-t border-border-default/60">
              <RefreshModelsButton state={refreshState} onRefresh={() => emit('refresh')} />
            </div>
          )}

          {/* Local / Worktree — isolation SELECTORS only (rule 4's
              inversion). Neither creates; both just toggle `isolation`. */}
          <IsolationRow
            isolation={isolation}
            modes={modes}
            onPick={(mode) => emit('pickIsolation', { isolation: mode })}
          />

          {isolation === 'worktree' && (
            <BranchPanel
              branchValue={branchValue}
              branchExists={branchExists}
              branchCreating={branchCreating}
              branchError={branchError}
              emit={emit}
            />
          )}
        </>
      )}
    </div>
  )

  const submenu =
    activeGroup && !loading ? (
      <SubmenuPanel
        activeGroup={activeGroup}
        isCommittedProvider={activeGroup.providerId === (selectedProviderId ?? 'claude')}
        selectedModelId={selectedModelId}
        activeGroupLastUsedId={activeGroupLastUsedId}
        highlighted={view === 'models' ? effectiveHighlighted : -1}
        onPointerEnter={() => {
          // Phantom-hover guard (see this file's header comment) — the
          // submenu appearing/resizing can itself move under a stationary
          // cursor and fire a spurious enter.
          if (!hasGenuinelyMoved()) return
          emit('enterSubmenu')
        }}
        onPointerLeave={() => {
          if (!hasGenuinelyMoved()) return
          emit('leaveSubmenu')
          // Pointer leaving the whole submenu panel — clear any row hover
          // inside it rather than leave a row lit with the pointer gone.
          setHoveredRow((current) => reduceRowHover({ type: 'clear' }, current))
        }}
        onRowHover={(idx) => {
          const genuine = hasGenuinelyMoved()
          setHoveredRow((current) =>
            reduceRowHover({ type: 'pointerEnter', panel: 'models', index: idx, genuine }, current)
          )
        }}
        onRowLeave={(idx) => {
          setHoveredRow((current) =>
            reduceRowHover({ type: 'pointerLeave', panel: 'models', index: idx }, current)
          )
        }}
        onPickModel={(providerId, modelId) => emit('pickModel', { providerId, modelId })}
      />
    ) : null

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setHoveredRow(null)
          emit('cancel')
        }
      }}
      // gap-0 (was gap-1.5) — see ChipGroupedDropdown.tsx's identical change
      // for the full rationale (user-reported "connect them"; safe to close
      // since the diagonal-traversal tolerance is time-based, not distance/
      // gap-based).
      className="flex items-start gap-0 outline-none font-[family-name:var(--font-sans)]"
    >
      {/* Flex order controls visual side — the submenu is always an IN-FLOW
          sibling (never `position: absolute`) so the overlay window's
          ResizeObserver-driven auto-sizing (OverlayRoot.tsx's `width:
          max-content` card) naturally grows to include it. Flipping `order`
          moves it to the LEFT of the parent panel with no re-mount, no
          manual geometry math beyond the boolean side decision itself. */}
      <div style={{ order: submenuSide === 'left' ? 0 : 2 }}>{submenu}</div>
      <div style={{ order: 1 }}>{parentPanel}</div>
    </div>
  )
}
