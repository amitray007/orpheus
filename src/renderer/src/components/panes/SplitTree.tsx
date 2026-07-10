// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/SplitTree.tsx
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U5, R6,
// KTD6). Renderer for a layout's `SplitTree` (src/shared/types.ts).
//
// FLAT-RENDER MODEL (fixes two related bugs — read before touching this
// file):
//
//   BUG #3 (flicker/setup-rerun on split): the ORIGINAL implementation
//   recursed the tree shape directly into JSX — a leaf rendered a
//   `<PaneCell>`, a node rendered a `<SplitNode>` wrapping two recursive
//   children. The instant a layout goes from a single leaf `{paneId:P1}` to
//   a node `{dir,a:{paneId:P1},b:{paneId:P2}}`, the element at THAT SLOT
//   changes type (PaneCell -> SplitNode) and P1's PaneCell moves one level
//   deeper in the DOM (nested under SplitNode's flex wrapper instead of
//   being the slot itself). React's reconciler diffs by (type, position in
//   parent), NOT by key alone — key only disambiguates among SAME-type
//   siblings under the SAME parent. A type/depth change unmounts the old
//   element and mounts a brand new one, tearing down + rebuilding EVERY
//   existing pane's native surface on every split (visible flicker), and
//   racing against the ✎/✕ destroy paths badly enough to rerun a pane's
//   setup command on what should have been a benign remount.
//
//   BUG #2 (first pane blank until a 2nd is added): the single-leaf path
//   used to render `<PaneCell>` directly as a bare child of the stage's
//   non-flex container (no sizing wrapper), so its body host could measure
//   a 0-height rect on the very first layout pass and PaneCell's mount
//   effect (no retry) gave up permanently until something else (like the
//   Bug #3 remount from adding a 2nd pane) re-ran it with a valid rect.
//
// THE FIX: `computeLeafRects` (splitTreeOps.ts) flattens the tree into a
// list of `{paneId, leftPct, topPct, widthPct, heightPct}` — one entry per
// leaf, in stable depth-first order — by walking the tree ONCE and
// subdividing rects the same way the old nested-flex layout did visually.
// This component then renders:
//
//   1. A PaneLayer: EVERY pane in the tree as a FLAT list of siblings, each
//      `key={paneId}` (immutable, unique, never reused), each wrapped in a
//      `position:absolute` div sized from its rect. Splitting/closing/
//      swapping changes which ENTRIES are in this list and what their rect
//      NUMBERS are — it never changes an existing pane's element type or
//      its depth/position in the parent. React therefore keeps every
//      existing `<PaneCell>` instance mounted across every tree mutation:
//      only its wrapper's inline left/top/width/height style updates.
//   2. A DividerLayer: the draggable seams, rendered SEPARATELY (not as
//      ancestors of any PaneCell — dividers and panes are flat siblings
//      under the same `relative` stage, dividers just paint on top via a
//      higher z-index) by walking the tree's NODES (not leaves) and
//      positioning one absolutely-placed `Divider` per node at the seam
//      between its `a`/`b` share.
//
// Cells render FLUSH + SQUARE: no cell margin/gap, no border-radius, no
// padding on the stage (enforced by the caller, PanesView) — overflow:
// hidden on the stage clips the outer frame's rounded corners, per the
// mockup's own comment (scratchpad/panes-final2.html). This is the single
// most visually distinctive requirement in the mockup; the flat-render
// rewrite preserves it exactly (cells sit edge-to-edge by rect math;
// dividers are thin seams painted over the shared boundary, not gaps).
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useRef, useState } from 'react'
import type { SplitDirection, SplitTree as SplitTreeShape } from '@shared/types'
import { PaneCell } from './PaneCell'
import {
  computeLeafRects,
  FULL_STAGE_RECT,
  type LeafRect,
  type SplitPathStep
} from './splitTreeOps'

export interface SplitTreeProps {
  tree: SplitTreeShape
  /** The owning layout's id — threaded down to every leaf so PaneCell can
   *  key its native surface `pane:<layoutId>:<paneId>`. */
  layoutId: string
  /** True when this whole tree's surfaces should be live: the Panes view is
   *  the active top-level view AND `layoutId` is the active layout. Passed
   *  through unchanged to every leaf (see PaneCell's own `active` prop) — a
   *  layout switch flips this false for the outgoing tree (hiding every
   *  pane in it on unmount/re-render) and true for the incoming one. */
  active: boolean
  /** Looks up a leaf's setup-rule command by paneId (backed by PanesView's
   *  loaded PaneTerminal rows) — PaneCell only needs the string, not the
   *  whole terminal row. */
  getCommand: (paneId: string) => string
  focusedPaneId: string | null
  onFocus: (paneId: string) => void
  onSplit: (paneId: string, dir: 'v' | 'h') => void
  onClose: (paneId: string) => void
  /** Persists an edited setup rule for a leaf's pane (PaneTerminal.command). */
  onCommandChange: (paneId: string, command: string) => void
  onSwap: (draggedPaneId: string, targetPaneId: string) => void
  onRatioChange: (path: SplitPathStep[], ratio: number) => void
  draggingPaneId: string | null
  onDragStart: (paneId: string) => void
  onDragEnd: () => void
}

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/** One node's geometry, flattened alongside its rect — the DividerLayer's
 *  unit of work. Mirrors computeLeafRects' walk but stops at NODES (a
 *  node's ratio is what a divider drags) instead of leaves, and carries the
 *  node's own addressing `path` (see splitTreeOps.ts's setRatio doc
 *  comment) so a drag can persist to the right tree location. */
interface NodeGeometry {
  path: SplitPathStep[]
  dir: SplitDirection
  ratio: number
  /** The seam's own rect — same box the two children split, i.e. what used
   *  to be `SplitNode`'s `containerRef` div — so the divider's drag math
   *  (pointer position relative to this box) is identical to before. */
  rect: LeafRect
}

/** Walks the tree's NODES (mirrors computeLeafRects' leaf walk) to produce
 *  one NodeGeometry per split, in the same depth-first order. Separate pure
 *  helper (not exported — DividerLayer-only concern, unlike computeLeafRects
 *  which PanesView/other future consumers may also want) so this component
 *  file, not splitTreeOps.ts, owns divider-specific geometry: computeLeafRects
 *  already covers the general "flatten the tree into rects" pure op that
 *  belongs in the ops module; this is just its node-level counterpart. */
function computeNodeGeometries(
  tree: SplitTreeShape,
  rect0: LeafRect,
  path: SplitPathStep[]
): NodeGeometry[] {
  if ('paneId' in tree) return []
  const ratio = clampRatio(tree.ratio)
  const { leftPct, topPct, widthPct, heightPct } = rect0
  const [rectA, rectB] =
    tree.dir === 'v'
      ? [
          { ...rect0, widthPct: widthPct * ratio },
          { ...rect0, leftPct: leftPct + widthPct * ratio, widthPct: widthPct * (1 - ratio) }
        ]
      : [
          { ...rect0, heightPct: heightPct * ratio },
          { ...rect0, topPct: topPct + heightPct * ratio, heightPct: heightPct * (1 - ratio) }
        ]
  return [
    { path, dir: tree.dir, ratio, rect: rect0 },
    ...computeNodeGeometries(tree.a, rectA, [...path, 'a']),
    ...computeNodeGeometries(tree.b, rectB, [...path, 'b'])
  ]
}

/** Divider — the thin draggable seam between a node's two children. Starts
 *  a pointer-capture drag on pointerdown; while dragging, updates LOCAL
 *  ratio state continuously (via `onLiveRatio`) and calls `onCommitRatio`
 *  exactly once, on pointerup, with the final value (persist-on-pointer-up
 *  per KTD6). Mirrors the mockup's divider `onpointerdown` handler's math
 *  exactly: `horiz ? (clientX-rect.left)/rect.width : (clientY-rect.top)/
 *  rect.height`, clamped to [0.15, 0.85]. Positioned absolutely over the
 *  seam between its node's two children (`rect` + `dir` + `ratio` locate
 *  it), rather than being an ancestor `<div>` the two children live inside
 *  — this keeps it a sibling of the PaneLayer's cells, not a wrapper, which
 *  is what makes the flat-render model possible. */
function Divider({
  geometry,
  stageRef,
  onLiveRatio,
  onCommitRatio
}: {
  geometry: NodeGeometry
  stageRef: React.RefObject<HTMLDivElement | null>
  onLiveRatio: (path: SplitPathStep[], ratio: number) => void
  onCommitRatio: (path: SplitPathStep[], ratio: number) => void
}): React.JSX.Element {
  const { path, dir, ratio, rect } = geometry
  const horiz = dir === 'v'

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)
      const stageRect = stageRef.current?.getBoundingClientRect()
      if (!stageRect) return
      // The node's own box in PIXELS, derived from the stage's pixel rect
      // and this node's percentage rect — reproduces the old per-node
      // containerRef's getBoundingClientRect() without needing a DOM node
      // per tree node.
      const boxLeft = stageRect.left + (rect.leftPct / 100) * stageRect.width
      const boxTop = stageRect.top + (rect.topPct / 100) * stageRect.height
      const boxWidth = (rect.widthPct / 100) * stageRect.width
      const boxHeight = (rect.heightPct / 100) * stageRect.height
      let finalRatio: number | null = null

      const move = (ev: PointerEvent): void => {
        const pos = horiz ? (ev.clientX - boxLeft) / boxWidth : (ev.clientY - boxTop) / boxHeight
        finalRatio = clampRatio(pos)
        onLiveRatio(path, finalRatio)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (finalRatio !== null) onCommitRatio(path, finalRatio)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [horiz, onCommitRatio, onLiveRatio, path, rect, stageRef]
  )

  // Seam position: centered on the boundary between the two children, i.e.
  // at `ratio` fraction across the node's own box, offset by the node's own
  // origin (leftPct/topPct) so nested splits seam correctly.
  const seamPct = horiz
    ? rect.leftPct + rect.widthPct * ratio
    : rect.topPct + rect.heightPct * ratio

  const style: React.CSSProperties = horiz
    ? {
        left: `${seamPct}%`,
        top: `${rect.topPct}%`,
        height: `${rect.heightPct}%`,
        width: 5,
        marginLeft: -2
      }
    : {
        top: `${seamPct}%`,
        left: `${rect.leftPct}%`,
        width: `${rect.widthPct}%`,
        height: 5,
        marginTop: -2
      }

  return (
    <div
      onPointerDown={handlePointerDown}
      style={{ position: 'absolute', ...style }}
      className={[
        'group/divider z-[2] bg-transparent',
        horiz ? 'cursor-col-resize' : 'cursor-row-resize'
      ].join(' ')}
    >
      <div
        className={[
          'absolute bg-transparent transition-colors duration-100 group-hover/divider:bg-accent',
          horiz ? 'inset-y-0 inset-x-[2px]' : 'inset-x-0 inset-y-[2px]'
        ].join(' ')}
      />
    </div>
  )
}

/** PaneLayer — the flat, stably-keyed list of every pane in the tree. This
 *  is the piece that makes Bug #3 impossible: `leafRects` is a flat array
 *  (one entry per leaf, `paneId`-keyed), so React's list reconciliation
 *  keys purely on `paneId` among same-type (`<PaneCell>`) siblings — adding/
 *  removing/reordering entries never touches an untouched entry's mounted
 *  instance. */
function PaneLayer(props: {
  leafRects: LeafRect[]
  layoutId: string
  active: boolean
  getCommand: (paneId: string) => string
  focusedPaneId: string | null
  onFocus: (paneId: string) => void
  onSplit: (paneId: string, dir: 'v' | 'h') => void
  onClose: (paneId: string) => void
  onCommandChange: (paneId: string, command: string) => void
  onSwap: (draggedPaneId: string, targetPaneId: string) => void
  draggingPaneId: string | null
  onDragStart: (paneId: string) => void
  onDragEnd: () => void
}): React.JSX.Element {
  return (
    <>
      {props.leafRects.map((r) => (
        <div
          key={r.paneId}
          style={{
            position: 'absolute',
            left: `${r.leftPct}%`,
            top: `${r.topPct}%`,
            width: `${r.widthPct}%`,
            height: `${r.heightPct}%`
          }}
          className="flex min-w-0 min-h-0"
        >
          <PaneCell
            layoutId={props.layoutId}
            paneId={r.paneId}
            command={props.getCommand(r.paneId)}
            active={props.active}
            animating={false}
            focused={props.focusedPaneId === r.paneId}
            onFocus={props.onFocus}
            onSplit={props.onSplit}
            onClose={props.onClose}
            onCommandChange={props.onCommandChange}
            draggingPaneId={props.draggingPaneId}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onSwap={props.onSwap}
          />
        </div>
      ))}
    </>
  )
}

export function SplitTree(props: SplitTreeProps): React.JSX.Element {
  const { tree } = props
  const stageRef = useRef<HTMLDivElement>(null)

  // Local "live" ratio overrides while a divider is mid-drag, keyed by the
  // node's own path (joined to a string — path arrays aren't stable identity
  // across renders, so they can't key a Map/object directly). Mirrors the
  // old per-SplitNode `useState<number|null>` but lifted to the tree root
  // since dividers are no longer nested components owning their own node's
  // state — there's one flat DividerLayer now.
  const [liveRatios, setLiveRatios] = useState<Record<string, number>>({})

  const handleLiveRatio = useCallback((path: SplitPathStep[], ratio: number) => {
    setLiveRatios((prev) => ({ ...prev, [path.join('')]: ratio }))
  }, [])

  const handleCommitRatio = useCallback(
    (path: SplitPathStep[], ratio: number) => {
      setLiveRatios((prev) => {
        const next = { ...prev }
        delete next[path.join('')]
        return next
      })
      props.onRatioChange(path, ratio)
    },
    [props]
  )

  // Overlay any in-flight live-drag ratios onto the persisted tree before
  // computing geometry, so dragging a divider feels instant (no IPC
  // round-trip per pointermove) without mutating the tree the caller owns.
  const liveTree = useMemo(() => applyLiveRatios(tree, liveRatios), [tree, liveRatios])

  const leafRects = useMemo(() => computeLeafRects(liveTree), [liveTree])
  const nodeGeometries = useMemo(
    () => computeNodeGeometries(liveTree, FULL_STAGE_RECT, []),
    [liveTree]
  )

  return (
    <div ref={stageRef} className="relative h-full w-full min-w-0 min-h-0">
      <PaneLayer
        leafRects={leafRects}
        layoutId={props.layoutId}
        active={props.active}
        getCommand={props.getCommand}
        focusedPaneId={props.focusedPaneId}
        onFocus={props.onFocus}
        onSplit={props.onSplit}
        onClose={props.onClose}
        onCommandChange={props.onCommandChange}
        onSwap={props.onSwap}
        draggingPaneId={props.draggingPaneId}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
      />
      {nodeGeometries.map((g) => (
        <Divider
          key={g.path.join('') || '(root)'}
          geometry={g}
          stageRef={stageRef}
          onLiveRatio={handleLiveRatio}
          onCommitRatio={handleCommitRatio}
        />
      ))}
    </div>
  )
}

/** Overlays any in-flight live-drag ratios (keyed by joined path) onto a
 *  fresh copy of `tree`'s node ratios, without touching the caller's
 *  persisted tree — purely a render-time view, same purity contract as
 *  splitTreeOps.ts's own ops (returns the same tree instance when there's
 *  nothing to override). Walks with structural sharing so an unrelated
 *  subtree's PaneCell wrapper doesn't get a new rect object identity for no
 *  reason (leafRects recomputation is cheap regardless, but keeping the
 *  same discipline as the ops module avoids surprises). */
function applyLiveRatios(tree: SplitTreeShape, liveRatios: Record<string, number>): SplitTreeShape {
  if (Object.keys(liveRatios).length === 0) return tree
  function walk(node: SplitTreeShape, path: SplitPathStep[]): SplitTreeShape {
    if ('paneId' in node) return node
    const key = path.join('')
    const ratio = key in liveRatios ? liveRatios[key] : node.ratio
    const a = walk(node.a, [...path, 'a'])
    const b = walk(node.b, [...path, 'b'])
    if (ratio === node.ratio && a === node.a && b === node.b) return node
    return { ...node, ratio, a, b }
  }
  return walk(tree, [])
}
