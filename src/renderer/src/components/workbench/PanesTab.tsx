// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/PanesTab.tsx
//
// U12 (P?) — the Workbench Panes tab: N persistent terminal panes tiled
// side-by-side (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md U12;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md). Each pane
// runs a user-declared command in its OWN native surface, keyed
// `pane:<workspaceId>:<paneId>` by the main-process handler (see
// src/main/index.ts's "Workbench Panes tab IPC (U12)" section) — UNLIKE the
// Terminal tab's single shared `workbench:<workspaceId>:<terminalId>` slot
// (one visible at a time, addon-evicted), every pane's slot is disjoint, so
// all of a workspace's panes can be mounted and VISIBLE SIMULTANEOUSLY, tiled
// into non-overlapping rects. That's the one structural difference from
// TerminalTab.tsx (this file's lifecycle pattern) — TerminalTab shows one
// surface at a time in one shared host div; here every tile gets its own
// independently-measured, independently-mounted/resized/hidden host div.
//
// v1 scope is a FLAT ROW ONLY — no nested split tree, no named/saved
// layouts, no command library (the requirements doc's fuller vision is
// deliberately deferred; see the interactive prototype this file's visual
// language + divider-drag math were drawn from). Persistence is SQLite-backed
// (via window.api.panes CRUD, not an in-memory per-key store like
// workbenchTerminalsStore.ts — the DB IS the store here) — a pane's
// {command, position, sizeFraction} survives app restart, but its surface
// does not: reopening always re-runs `command` fresh in a brand new process,
// same as any other libghostty surface boot.
//
// Surface lifecycle guards below are copied 1:1 from TerminalTab.tsx (its
// header comment explains the WHY in full) — MIN_SURFACE_PX floor,
// active/animating gating, unmountedRef + pendingCloseRef race guards,
// hide-on-cleanup-but-only-if-didMount, and a separate `[]`-keyed true-
// unmount effect that HIDES (never destroys) every pane's surface. The ONLY
// destroy triggers here are (a) a pane's own ✕-close and (b) an edit-command
// commit (a command change means a fresh process, so the old surface is
// destroyed and a new one mounted) — mirroring TerminalTab's own "destroyed
// ONLY by (f)/(g)" invariant, with (edit-command relaunch) added as a v1-
// specific third trigger unique to panes (TerminalTab has no equivalent,
// since its terminals don't have a persisted command to edit).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Plus, X, PencilSimple } from '@phosphor-icons/react'
import type { Pane } from '@shared/types'
import { useInlineRename } from '@/lib/useInlineRename'

// See TerminalTab.tsx's own MIN_SURFACE_PX for the full rationale — identical
// guard, applied per-pane-tile instead of per-shared-host-div: a collapsing/
// animating container must never hand libghostty a near-zero rect, or the
// reflow permanently drops scrollback (moot for panes today since panes carry
// no scrollback across restart, but the guard also protects against the
// SAME transient near-zero measurement making the addon do a wasted/thrashing
// resize during the Workbench's own open/expand/collapse width animation).
const MIN_SURFACE_PX = 40

// Floor for a tile's flex-basis percentage — mirrors the prototype's
// clamp(0.15, ratio, 0.85) so a divider drag can never squeeze a neighbor
// down to (or past) the point its surface would be measured below
// MIN_SURFACE_PX and get its resize dropped.
const MIN_SIZE_FRACTION = 0.15
const MAX_SIZE_FRACTION = 0.85

export interface PanesTabProps {
  /** The owning claude workspace's id. Each pane's native surface is keyed
   *  `pane:<workspaceId>:<paneId>` by the main-process handler. */
  workspaceId: string
  /** True when this tab body should be live: the Panes tab is the active
   *  Workbench tab AND the Workbench is open or expanded. Mirrors
   *  TerminalTab's own `active` prop exactly. */
  active: boolean
  /** True while the Workbench frame's width is mid-transition. See
   *  TerminalTab.tsx's own `animating` doc — same guard, same reason: a
   *  mid-animation resize would reflow-and-thrash every tile's surface. */
  animating: boolean
}

/**
 * Resolve every pane's DISPLAY sizeFraction from its (possibly stale/
 * inconsistent) PERSISTED sizeFraction, in two passes:
 *
 *  1. Give each unset (0) pane a provisional share equal to `1 / paneCount`
 *     — an equal cut of the WHOLE row, not just of whatever's "left over"
 *     from the explicitly-sized panes (that leftover-based approach is what
 *     broke below — see the bug this replaced).
 *  2. NORMALIZE every pane's resulting fraction so the row always sums to
 *     EXACTLY 1, regardless of how the persisted fractions got here.
 *
 * This fixes a real bug the previous (leftover-only) version had: persisted
 * fractions only stay summed-to-1 if every add/close/drag perfectly
 * re-balances every OTHER pane too, which they don't (by design — a drag
 * only touches its two neighbors, a close simply removes a row, an add
 * appends a 0). Two concrete cases this must get right:
 *   - 3 panes at .333 each (sums to 1); close the middle one -> the two
 *     survivors are still .333/.333 (sums to .666, dead gap on the right)
 *     unless renormalized here to .5/.5.
 *   - 2 panes at .5/.5; add a third at 0 -> giving it a "leftover" share
 *     (1 - 1 = 0) would mount it at literal 0 width (invisible, and its
 *     resize gets dropped by the MIN_SURFACE_PX floor). Giving it `1/3` up
 *     front and then normalizing the trio (.5, .5, .333 -> sum 1.333) yields
 *     .375/.375/.25 — every pane visible, no zero-width pane, and the row
 *     stays proportionate to the persisted 1:1 ratio between the first two.
 * Renormalizing on every render (rather than trying to keep persisted
 * fractions perfectly rebalanced on every mutation) means the DISPLAYED row
 * is always internally consistent even when what's on disk is stale or from
 * a different pane count.
 */
function withResolvedFractions(panes: readonly Pane[]): Pane[] {
  if (panes.length === 0) return []
  const evenShare = 1 / panes.length
  const withShares = panes.map((p) => ({
    ...p,
    sizeFraction: p.sizeFraction || evenShare
  }))
  const total = withShares.reduce((sum, p) => sum + p.sizeFraction, 0)
  if (total <= 0) return withShares // defensive: never divide by zero
  return withShares.map((p) => ({ ...p, sizeFraction: p.sizeFraction / total }))
}

export function PanesTab({ workspaceId, active, animating }: PanesTabProps): React.JSX.Element {
  const [panes, setPanes] = useState<Pane[]>([])
  const [loaded, setLoaded] = useState(false)
  // addingCommand — non-null while the "＋ Add pane" inline command input is
  // open (empty string is a valid in-progress value, so presence is tracked
  // by nullability, not truthiness).
  const [addingCommand, setAddingCommand] = useState<string | null>(null)
  // editingPaneId — which pane's command is currently being edited inline
  // (null when none). Only one edit editor is open at a time, matching the
  // single always-one-rename-active convention elsewhere in the app.
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null)

  // Load the persisted pane list once on mount. The DB is the sole source of
  // truth for the list itself (unlike workbenchTerminalsStore's in-memory
  // per-key store) — there's nothing to seed synchronously on first render,
  // so this starts empty and fills in once panes:list resolves.
  useEffect(() => {
    let cancelled = false
    window.api.panes
      .list(workspaceId)
      .then((list) => {
        if (cancelled) return
        setPanes(list.slice().sort((a, b) => a.position - b.position))
        setLoaded(true)
      })
      .catch((e) => console.error('[PanesTab] list failed:', e))
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const resolvedPanes = withResolvedFractions(panes)

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <div className="h-8 flex-shrink-0 border-b border-border-default flex items-center px-1">
        <PanesToolbar
          adding={addingCommand !== null}
          onBeginAdd={() => setAddingCommand('')}
          command={addingCommand ?? ''}
          onCommandChange={setAddingCommand}
          onCancel={() => setAddingCommand(null)}
          onSubmit={(command) => {
            setAddingCommand(null)
            const position = panes.length === 0 ? 0 : Math.max(...panes.map((p) => p.position)) + 1
            window.api.panes
              .create({ workspaceId, command, position, sizeFraction: 0 })
              .then((pane) => setPanes((prev) => [...prev, pane]))
              .catch((e) => console.error('[PanesTab] create failed:', e))
          }}
        />
      </div>
      <div className="flex-1 min-w-0 min-h-0 flex flex-row overflow-hidden">
        {loaded && resolvedPanes.length === 0 && (
          <PanesEmptyState onAdd={() => setAddingCommand('')} />
        )}
        {resolvedPanes.map((pane, i) => (
          <PaneTileGroup
            key={pane.id}
            workspaceId={workspaceId}
            pane={pane}
            isLast={i === resolvedPanes.length - 1}
            active={active}
            animating={animating}
            editing={editingPaneId === pane.id}
            onBeginEdit={() => setEditingPaneId(pane.id)}
            onCancelEdit={() => setEditingPaneId(null)}
            onCommandCommitted={() => setEditingPaneId(null)}
            onDivider={(deltaFraction) => {
              const next = resolvedPanes[i + 1]
              if (!next) return
              adjustNeighborFractions(pane, next, deltaFraction, setPanes)
            }}
            onDividerCommit={() => {
              const next = resolvedPanes[i + 1]
              if (!next) return
              // Re-read the LATEST fractions from `panes` (not the possibly-
              // stale `pane`/`next` this closure captured at last render) —
              // several pointermove-driven onDivider calls may have run
              // between this render and pointerup. Persist only the two
              // neighbors this divider actually adjusts, per FIX 2.
              setPanes((prev) => {
                const left = prev.find((p) => p.id === pane.id)
                const right = prev.find((p) => p.id === next.id)
                if (left) {
                  window.api.panes
                    .update(left.id, { sizeFraction: left.sizeFraction })
                    .catch((e) => console.error('[PanesTab] divider persist (left) failed:', e))
                }
                if (right) {
                  window.api.panes
                    .update(right.id, { sizeFraction: right.sizeFraction })
                    .catch((e) => console.error('[PanesTab] divider persist (right) failed:', e))
                }
                return prev
              })
            }}
            onClose={() => {
              setPanes((prev) => prev.filter((p) => p.id !== pane.id))
              window.api.panes
                .delete(pane.id)
                .catch((e) => console.error('[PanesTab] delete failed:', e))
              window.api.panes
                .destroy(workspaceId, pane.id)
                .catch((e) => console.error('[PanesTab] close destroy failed:', e))
            }}
            onCommandChange={(patch) => {
              setPanes((prev) => prev.map((p) => (p.id === pane.id ? { ...p, ...patch } : p)))
            }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Clamp + redistribute sizeFraction between two adjacent panes after a
 * divider drag — LOCAL state only, no IPC. Called on every pointermove for a
 * responsive drag; persistence is a separate, single round-trip fired once
 * on pointerup (see the `onDividerCommit` handler above and
 * PaneTileGroup's handleUp below) — a naive per-move `panes:update` would be
 * dozens of SQLite writes per drag for no user-visible benefit, since only
 * the FINAL fractions need to survive a reload.
 */
function adjustNeighborFractions(
  left: Pane,
  right: Pane,
  deltaFraction: number,
  setPanes: React.Dispatch<React.SetStateAction<Pane[]>>
): void {
  const pairTotal = left.sizeFraction + right.sizeFraction
  const rawLeft = left.sizeFraction + deltaFraction
  // The 15/85 clamp applies to the dragged PAIR's own combined share (not the
  // whole row) — so a drag between two small panes in a wide row still can't
  // squeeze either below its visibility floor relative to its neighbor.
  const clampedLeft = Math.min(
    pairTotal * MAX_SIZE_FRACTION,
    Math.max(pairTotal * MIN_SIZE_FRACTION, rawLeft)
  )
  const clampedRight = pairTotal - clampedLeft
  setPanes((prev) =>
    prev.map((p) => {
      if (p.id === left.id) return { ...p, sizeFraction: clampedLeft }
      if (p.id === right.id) return { ...p, sizeFraction: clampedRight }
      return p
    })
  )
}

interface PanesToolbarProps {
  adding: boolean
  command: string
  onCommandChange: (v: string) => void
  onBeginAdd: () => void
  onCancel: () => void
  onSubmit: (command: string) => void
}

/** The "＋ Add pane" affordance + its inline command input, split out of
 *  PanesTab's render body. An empty command is a valid submission — "just a
 *  shell" per the spec — so onSubmit always fires on Enter/blur-with-value,
 *  never gated on non-empty text. */
function PanesToolbar({
  adding,
  command,
  onCommandChange,
  onBeginAdd,
  onCancel,
  onSubmit
}: PanesToolbarProps): React.JSX.Element {
  if (!adding) {
    return (
      <button
        type="button"
        aria-label="Add pane"
        title="Add pane"
        onClick={onBeginAdd}
        className="flex items-center gap-1 px-2 h-6 rounded text-xs font-medium text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <Plus size={12} />
        Add pane
      </button>
    )
  }

  return (
    <input
      autoFocus
      type="text"
      value={command}
      placeholder="Command (leave blank for a shell)"
      onChange={(e) => onCommandChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSubmit(command.trim())
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onSubmit(command.trim())}
      className="w-64 px-2 h-6 rounded text-xs font-mono bg-surface-overlay border border-border-default text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
    />
  )
}

function PanesEmptyState({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 min-h-0 min-w-0">
      <span className="text-xs text-text-muted select-none">No panes yet</span>
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <Plus size={12} />＋ Add pane
      </button>
    </div>
  )
}

interface PaneTileGroupProps {
  workspaceId: string
  pane: Pane
  isLast: boolean
  active: boolean
  animating: boolean
  editing: boolean
  onBeginEdit: () => void
  onCancelEdit: () => void
  onCommandCommitted: () => void
  /** Fired on every pointermove during a drag — updates LOCAL state only
   *  (see adjustNeighborFractions), no IPC. Keeps the drag responsive. */
  onDivider: (deltaFraction: number) => void
  /** Fired ONCE on pointerup — persists the two dragged neighbors' final
   *  fractions (FIX 2: avoids a panes:update round-trip per pointermove). */
  onDividerCommit: () => void
  onClose: () => void
  onCommandChange: (patch: Partial<Pick<Pane, 'command' | 'title'>>) => void
}

/** One tile + (if not the last tile) its trailing divider. Grouping the two
 *  as siblings (rather than a single PaneTile handling its own divider) keeps
 *  the divider's drag math scoped to exactly the two neighbors it adjusts,
 *  mirroring the prototype's wrap/divider/wrap triple. */
function PaneTileGroup({
  workspaceId,
  pane,
  isLast,
  active,
  animating,
  editing,
  onBeginEdit,
  onCancelEdit,
  onCommandCommitted,
  onDivider,
  onDividerCommit,
  onClose,
  onCommandChange
}: PaneTileGroupProps): React.JSX.Element {
  const dragStateRef = useRef<{ startX: number; containerWidth: number } | null>(null)

  function handleDividerPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    const container = target.parentElement
    const containerWidth = container?.getBoundingClientRect().width ?? 1
    dragStateRef.current = { startX: e.clientX, containerWidth }

    const handleMove = (ev: PointerEvent): void => {
      const drag = dragStateRef.current
      if (!drag) return
      const deltaPx = ev.clientX - drag.startX
      const deltaFraction = deltaPx / drag.containerWidth
      onDivider(deltaFraction)
      dragStateRef.current = { startX: ev.clientX, containerWidth: drag.containerWidth }
    }
    const handleUp = (): void => {
      dragStateRef.current = null
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      // Persist the final fractions ONCE — see onDividerCommit's own doc.
      onDividerCommit()
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
  }

  return (
    <>
      <div
        className="flex flex-col min-w-0 min-h-0 overflow-hidden"
        style={{ flex: `${pane.sizeFraction} 1 0%` }}
      >
        <PaneTile
          workspaceId={workspaceId}
          pane={pane}
          active={active}
          animating={animating}
          editing={editing}
          onBeginEdit={onBeginEdit}
          onCancelEdit={onCancelEdit}
          onCommandCommitted={onCommandCommitted}
          onClose={onClose}
          onCommandChange={onCommandChange}
        />
      </div>
      {!isLast && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize pane"
          onPointerDown={handleDividerPointerDown}
          className="w-1 flex-shrink-0 cursor-col-resize hover:bg-accent/40 transition-colors duration-150 bg-transparent"
        />
      )}
    </>
  )
}

interface PaneTileProps {
  workspaceId: string
  pane: Pane
  active: boolean
  animating: boolean
  editing: boolean
  onBeginEdit: () => void
  onCancelEdit: () => void
  onCommandCommitted: () => void
  onClose: () => void
  onCommandChange: (patch: Partial<Pick<Pane, 'command' | 'title'>>) => void
}

/**
 * A single pane's header (command chip + edit + close) plus its own
 * independently-measured, independently-mounted host div. Surface lifecycle
 * mirrors TerminalTab.tsx's active-effect PER PANE — see this file's header
 * comment for the full rationale of why panes need N independent copies of
 * that pattern instead of TerminalTab's one-shared-host-div version.
 */
function PaneTile({
  workspaceId,
  pane,
  active,
  animating,
  editing,
  onBeginEdit,
  onCancelEdit,
  onCommandCommitted,
  onClose,
  onCommandChange
}: PaneTileProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  // activeRef/animatingRef — same render-time-mutated-ref idiom as
  // TerminalTab.tsx, so the stable ResizeObserver-driven resize path always
  // reads the LATEST active/animating without re-subscribing.
  const activeRef = useRef(active)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track latest active prop for the stable resize listeners
  activeRef.current = active
  const animatingRef = useRef(animating)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track latest animating prop for the stable resize listeners
  animatingRef.current = animating

  // createdRef — has this pane's surface actually been mounted at least once
  // (this component instance's lifetime)? Generalizes TerminalTab's
  // createdKeysRef Set down to a single boolean, since each PaneTile only
  // ever owns exactly one pane id (no switching between ids like
  // TerminalTab's activeTerminalId).
  const createdRef = useRef(false)
  // unmountedRef/pendingCloseRef — identical race guards to TerminalTab.tsx:
  // an in-flight pane:mount resolving after this tile has torn down (or after
  // the user already clicked ✕) must hide/destroy itself instead of leaking
  // a visible surface for a pane the strip no longer shows.
  const unmountedRef = useRef(false)
  const pendingCloseRef = useRef(false)

  // relaunchCommandRef — the command a mount call was issued with. Compared
  // against the CURRENT pane.command inside the mount .then() so an edit-
  // command commit that fires WHILE a mount is still in flight (rare, but
  // the same class of race TerminalTab guards elsewhere) doesn't leave a
  // stale-command surface mounted — see the relaunch effect below, which is
  // the primary path for command changes; this ref only closes the in-flight
  // race window.
  const mountedCommandRef = useRef<string | null>(null)

  useEffect(() => {
    let resizeRafId: number | null = null
    let pendingRect: { x: number; y: number; w: number; h: number } | null = null
    let pendingSf = 1
    let ro: ResizeObserver | null = null
    let mountRafId: number | null = null
    // See TerminalTab.tsx's own `didMount` — same guard, same reason: only a
    // run that actually mounted+showed a surface should hide it on cleanup.
    let didMount = false

    const flushResize = (): void => {
      resizeRafId = null
      if (!pendingRect) return
      if (!activeRef.current || animatingRef.current) {
        pendingRect = null
        return
      }
      window.api.panes
        .resize(workspaceId, pane.id, pendingRect, pendingSf)
        .catch((e) => console.error('[PanesTab] resize failed:', e))
      pendingRect = null
    }

    // Same three guards as TerminalTab.tsx's scheduleResize: state (active),
    // animation (Workbench width transition), and the MIN_SURFACE_PX floor —
    // see that file's header comment for the full rationale. A divider drag
    // between two tiles legitimately resizes both neighbors; it sets no
    // `animating` flag, so it flows straight through here.
    const scheduleResize = (rect: DOMRect): void => {
      if (!activeRef.current || animatingRef.current) return
      if (rect.width < MIN_SURFACE_PX || rect.height < MIN_SURFACE_PX) return
      pendingSf = window.devicePixelRatio ?? 1
      pendingRect = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      }
      if (resizeRafId === null) {
        resizeRafId = requestAnimationFrame(flushResize)
      }
    }

    const attachResizeListener = (): void => {
      const el = containerRef.current
      if (!el || ro) return
      ro = new ResizeObserver(() => {
        scheduleResize(el.getBoundingClientRect())
      })
      ro.observe(el)
    }

    if (active && !animating) {
      didMount = true
      mountRafId = requestAnimationFrame(() => {
        mountRafId = null
        const el = containerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const scaleFactor = window.devicePixelRatio ?? 1
        const paneRect = {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
        mountedCommandRef.current = pane.command
        window.api.panes
          .mount(workspaceId, pane.id, paneRect, scaleFactor, pane.command)
          .then(() => {
            createdRef.current = true
            if (pendingCloseRef.current) {
              pendingCloseRef.current = false
              createdRef.current = false
              window.api.panes
                .destroy(workspaceId, pane.id)
                .catch((e) => console.error('[PanesTab] deferred close destroy failed:', e))
              return
            }
            if (unmountedRef.current) {
              window.api.panes
                .hide(workspaceId, pane.id)
                .catch((e) => console.error('[PanesTab] post-unmount hide failed:', e))
              return
            }
            attachResizeListener()
          })
          .catch((e) => console.error('[PanesTab] mount failed:', e))
      })
    }

    return () => {
      if (mountRafId !== null) cancelAnimationFrame(mountRafId)
      if (resizeRafId !== null) cancelAnimationFrame(resizeRafId)
      ro?.disconnect()
      pendingRect = null
      // Hide (never destroy) on every run whose mount actually showed the
      // surface — covers the tab deactivating or the Workbench collapsing.
      if (didMount && createdRef.current) {
        window.api.panes
          .hide(workspaceId, pane.id)
          .catch((e) => console.error('[PanesTab] hide failed:', e))
      }
    }
    // Re-runs on active/animating transitions, same as TerminalTab.tsx.
    // pane.command is intentionally NOT a dep — a command edit is relaunched
    // by the dedicated effect below (destroy old -> mount new), not by
    // tearing down and rebuilding this whole active-effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, animating, workspaceId, pane.id])

  // True teardown — separate `[]`-keyed effect, fires only on this PaneTile
  // instance's own unmount (pane removed from the list entirely via a
  // DIFFERENT path than ✕-close — e.g. the whole Workbench/workspace tearing
  // down). HIDE, never destroy — mirrors TerminalTab.tsx's own unmount
  // effect exactly; the pane's surface is destroyed authoritatively by main's
  // per-workspace surface registry on workspace archive/removal, same as
  // every other surface kind in this app.
  useEffect(() => {
    return () => {
      unmountedRef.current = true
      if (createdRef.current) {
        window.api.panes
          .hide(workspaceId, pane.id)
          .catch((e) => console.error('[PanesTab] post-unmount hide failed:', e))
      }
    }
    // workspaceId/pane.id are stable for this PaneTile instance's lifetime —
    // a command edit changes pane.command, not pane.id (see paneStore.update,
    // which mutates the row in place), so this effect never re-runs for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Command-change relaunch: destroy the old surface and mount a fresh one
  // whenever pane.command changes AFTER the initial mount (skips the very
  // first mount, which the active-effect above already handles with the
  // pane's CURRENT command at that time). A command change means a new
  // process — that's the explicit, expected behavior per the spec, not a
  // bug: there is no way to change what's running inside an already-live
  // shell's argv without restarting it.
  const isFirstCommandRef = useRef(true)
  useEffect(() => {
    if (isFirstCommandRef.current) {
      isFirstCommandRef.current = false
      return
    }
    if (mountedCommandRef.current === pane.command) return
    if (!createdRef.current) return // not mounted yet; the active-effect will pick up the new command
    if (!active || animating) return // relaunch only while genuinely visible

    createdRef.current = false
    window.api.panes
      .destroy(workspaceId, pane.id)
      .then(() => {
        const el = containerRef.current
        if (!el || unmountedRef.current) return
        const rect = el.getBoundingClientRect()
        const scaleFactor = window.devicePixelRatio ?? 1
        const paneRect = {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          w: Math.round(rect.width),
          h: Math.round(rect.height)
        }
        mountedCommandRef.current = pane.command
        return window.api.panes.mount(workspaceId, pane.id, paneRect, scaleFactor, pane.command)
      })
      .then((result) => {
        if (!result) return
        createdRef.current = true
      })
      .catch((e) => console.error('[PanesTab] command-change relaunch failed:', e))
    // active/animating deliberately excluded from deps — this effect keys
    // ONLY on the command actually changing; active/animating gating is
    // re-checked at the time of the change via the refs, not by re-running
    // this effect when they flip on their own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.command, workspaceId, pane.id])

  const handleClose = useCallback((): void => {
    if (createdRef.current) {
      createdRef.current = false
      // The destroy IPC itself is fired by the parent's onClose (it owns
      // panes:delete + pane:destroy together) — this tile only needs to mark
      // itself so an in-flight mount doesn't race past this point (see
      // pendingCloseRef below) and so its own effects don't also try to hide
      // an already-destroyed surface.
    } else {
      pendingCloseRef.current = true
    }
    onClose()
  }, [onClose])

  return (
    <>
      <PaneTileHeader
        pane={pane}
        editing={editing}
        onBeginEdit={onBeginEdit}
        onCancelEdit={onCancelEdit}
        onCommandCommitted={onCommandCommitted}
        onClose={handleClose}
        onCommandChange={onCommandChange}
      />
      <div
        ref={containerRef}
        className="flex-1 min-w-0 min-h-0 relative"
        // Transparent host — the opaque libghostty NSView paints through,
        // same convention as TerminalTab.tsx's own host div.
      />
    </>
  )
}

interface PaneTileHeaderProps {
  pane: Pane
  editing: boolean
  onBeginEdit: () => void
  onCancelEdit: () => void
  onCommandCommitted: () => void
  onClose: () => void
  onCommandChange: (patch: Partial<Pick<Pane, 'command' | 'title'>>) => void
}

/** The per-tile header row: title/command label, an edit (pencil) control,
 *  and a close (✕) control — split out so PaneTile's own body stays focused
 *  on surface lifecycle. Styling mirrors TerminalStrip.tsx's tab controls
 *  (hover-revealed ✕, focus rings, same size/spacing conventions). */
function PaneTileHeader({
  pane,
  editing,
  onBeginEdit,
  onCancelEdit,
  onCommandCommitted,
  onClose,
  onCommandChange
}: PaneTileHeaderProps): React.JSX.Element {
  const label = pane.title?.trim() || pane.command.trim() || 'Shell'
  const rename = useInlineRename(pane.command, (trimmed) => {
    onCommandChange({ command: trimmed })
    onCommandCommitted()
  })

  useEffect(() => {
    if (editing) rename.seed(pane.command)
    // Re-seed only when edit mode is freshly entered — not on every
    // pane.command change (that would fight the user's in-progress typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  if (editing) {
    return (
      <div className="h-8 flex-shrink-0 border-b border-border-default flex items-center px-2 gap-1.5">
        <input
          autoFocus
          type="text"
          value={rename.value}
          placeholder="Command (leave blank for a shell)"
          onChange={(e) => rename.setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              rename.commit()
              onCommandCommitted()
            } else if (e.key === 'Escape') {
              rename.cancel()
              onCancelEdit()
            }
          }}
          onBlur={() => {
            rename.commit()
            onCommandCommitted()
          }}
          className="flex-1 min-w-0 px-2 h-6 rounded text-xs font-mono bg-surface-overlay border border-accent/40 text-text-primary focus-visible:outline-none"
        />
      </div>
    )
  }

  return (
    <div className="h-8 flex-shrink-0 border-b border-border-default flex items-center px-2 gap-1.5 group">
      <button
        type="button"
        title="Edit command"
        onClick={onBeginEdit}
        className="flex-1 min-w-0 text-left truncate text-xs font-mono text-text-muted hover:text-text-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-sm"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label="Edit command"
        title="Edit command"
        onClick={onBeginEdit}
        className="flex items-center justify-center w-5 h-5 rounded-sm flex-shrink-0 cursor-pointer text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-surface-overlay hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <PencilSimple size={11} />
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        onClick={onClose}
        className="flex items-center justify-center w-5 h-5 rounded-sm flex-shrink-0 cursor-pointer text-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-surface-overlay hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <X size={11} />
      </button>
    </div>
  )
}
