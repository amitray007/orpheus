// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/SplitTree.tsx
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U5, R6,
// KTD6). Recursive renderer for a layout's `SplitTree` (src/shared/types.ts):
// a leaf renders a `PaneCell`; a node renders its two children in a flex row
// ('v' — side-by-side) or column ('h' — stacked), sized by `flex` basis
// (not width/height percentages — mirrors the mockup's own
// `wa.style.flex`/`wb.style.flex` mechanism exactly, scratchpad/
// panes-final2.html's `renderNode`), separated by a draggable `Divider`.
//
// Cells render FLUSH + SQUARE: no cell margin (`gap-0` split container), no
// border-radius, no padding on the stage (enforced by the caller, PanesView)
// — overflow:hidden on the stage clips the outer frame's rounded corners,
// per the mockup's own comment. This is the single most visually
// distinctive requirement in the mockup; do not soften it.
// ---------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react'
import type { SplitDirection, SplitTree as SplitTreeShape } from '@shared/types'
import { PaneCell } from './PaneCell'
import type { SplitPathStep } from './splitTreeOps'

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
  /** Node-addressing path from the root to THIS node — see splitTreeOps.ts's
   *  setRatio doc comment for the full addressing-scheme explanation. Passed
   *  down recursively so leaf-level callbacks (split/close/swap) don't need
   *  it, but the divider drag handler at each node level does, to identify
   *  which node it's resizing. */
  path: SplitPathStep[]
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

/** Divider — the thin draggable seam between a node's two children. Starts
 *  a pointer-capture drag on pointerdown; while dragging, updates LOCAL
 *  ratio state continuously (via `onLiveRatio`, a same-render callback into
 *  the parent Node component — NOT the persisted `onRatioChange`, which
 *  would spam IPC on every pointermove) and calls `onRatioChange` exactly
 *  once, on pointerup, with the final value (persist-on-pointer-up per
 *  KTD6). Mirrors the mockup's divider `onpointerdown` handler's math
 *  exactly: `horiz ? (clientX-rect.left)/rect.width : (clientY-rect.top)/
 *  rect.height`, clamped to [0.15, 0.85]. */
function Divider({
  dir,
  containerRef,
  onLiveRatio,
  onCommitRatio
}: {
  dir: SplitDirection
  containerRef: React.RefObject<HTMLDivElement | null>
  onLiveRatio: (ratio: number) => void
  onCommitRatio: (ratio: number) => void
}): React.JSX.Element {
  const horiz = dir === 'v'

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      let finalRatio: number | null = null

      const move = (ev: PointerEvent): void => {
        const pos = horiz
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height
        finalRatio = clampRatio(pos)
        onLiveRatio(finalRatio)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (finalRatio !== null) onCommitRatio(finalRatio)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [containerRef, horiz, onLiveRatio, onCommitRatio]
  )

  return (
    <div
      onPointerDown={handlePointerDown}
      className={[
        'group/divider relative z-[2] flex-none bg-transparent',
        horiz ? 'w-[5px] -mx-[2px] cursor-col-resize' : 'h-[5px] -my-[2px] cursor-row-resize'
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

export function SplitTree(props: SplitTreeProps): React.JSX.Element {
  const { tree } = props
  if ('paneId' in tree) {
    return (
      <PaneCell
        // key = paneId — the split tree's shape is rebuilt (spread-copied)
        // on every split/close/swap/ratio change (splitTreeOps.ts's purity
        // contract), so without a stable key React could remount a leaf
        // that just moved to a different position in its parent's a/b
        // slot, tearing down + re-mounting its native surface for no
        // functional reason. paneId is immutable for a pane's whole life.
        key={tree.paneId}
        layoutId={props.layoutId}
        paneId={tree.paneId}
        command={props.getCommand(tree.paneId)}
        active={props.active}
        animating={false}
        focused={props.focusedPaneId === tree.paneId}
        onFocus={props.onFocus}
        onSplit={props.onSplit}
        onClose={props.onClose}
        onCommandChange={props.onCommandChange}
        draggingPaneId={props.draggingPaneId}
        onDragStart={props.onDragStart}
        onDragEnd={props.onDragEnd}
        onSwap={props.onSwap}
      />
    )
  }
  return <SplitNode {...props} tree={tree} />
}

/** The node-rendering half of SplitTree, split out as its own component so
 *  the leaf-vs-node branch above stays trivial and this piece can own the
 *  ratio-drag local state + divider math without inflating one giant
 *  function's cognitive complexity. */
function SplitNode(
  props: SplitTreeProps & {
    tree: Extract<SplitTreeShape, { dir: SplitDirection }>
  }
): React.JSX.Element {
  const { tree, path } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [liveRatio, setLiveRatio] = useState<number | null>(null)
  const ratio = liveRatio ?? tree.ratio

  const handleCommitRatio = useCallback(
    (finalRatio: number) => {
      setLiveRatio(null)
      props.onRatioChange(path, finalRatio)
    },
    [path, props]
  )

  return (
    <div
      ref={containerRef}
      className={[
        'flex h-full w-full min-w-0 min-h-0',
        tree.dir === 'v' ? 'flex-row' : 'flex-col'
      ].join(' ')}
    >
      <div className="flex min-w-0 min-h-0 flex-1" style={{ flex: `${ratio} 1 0` }}>
        <SplitTree {...props} tree={tree.a} path={[...path, 'a']} />
      </div>
      <Divider
        dir={tree.dir}
        containerRef={containerRef}
        onLiveRatio={setLiveRatio}
        onCommitRatio={handleCommitRatio}
      />
      <div className="flex min-w-0 min-h-0 flex-1" style={{ flex: `${1 - ratio} 1 0` }}>
        <SplitTree {...props} tree={tree.b} path={[...path, 'b']} />
      </div>
    </div>
  )
}
