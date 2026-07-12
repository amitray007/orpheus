// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/splitTreeOps.ts
//
// NOTE ON THE FILENAME: the plan doc's indicative file list names this
// module `splitTree.ts`. It's named `splitTreeOps.ts` here instead purely
// because this codebase's git worktree lives on a case-insensitive macOS
// filesystem, and TypeScript's compiler rejects `splitTree.ts` and
// `SplitTree.tsx` (the recursive renderer component in this same directory)
// coexisting in one module graph — a real TS2367/TS1149 error, not a lint
// nit — regardless of the OS actually keeping them as two distinct
// case-preserved files on disk. Renaming the PURE-OPS module (rather than
// the component, which follows this repo's PascalCase-for-components
// convention) was the least surprising fix.
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U5, R6,
// KTD6). Pure, side-effect-free operations over the `SplitTree` shape
// (src/shared/types.ts):
//
//   type SplitTree =
//     | { paneId: string }
//     | { dir: SplitDirection; a: SplitTree; b: SplitTree; ratio: number }
//
// A leaf holds one pane's id; a node is a binary split ('v' = side-by-side,
// new pane to the right; 'h' = stacked, new pane below) with `ratio` the
// first child's (`a`'s) share of the split axis, always clamped to
// [0.15, 0.85] so neither side of a divider can be dragged to zero width.
//
// This module mirrors the reference mockup's `splitPane` / `closePane` /
// `swapPanes` tree-shape semantics 1:1 (scratchpad/panes-final2.html) — see
// each function's header for the corresponding mockup helper.
//
// PURITY CONTRACT: every exported function here returns a NEW tree (or the
// SAME tree instance, unchanged, when there's nothing to do) and never
// mutates its input `tree` argument or any nested object reachable from it.
// Only the ancestors on the path from the root to the changed node are
// reconstructed (spread-copied); untouched subtrees are returned by
// reference (structural sharing) — this matches the mockup's own
// `rebuild()` helpers, e.g. `{...t, a: rebuild(t.a), b: rebuild(t.b)}`.
//
// NOT-FOUND CONVENTION: every function that takes a target paneId (or node
// path) that might not exist in the tree returns the ORIGINAL tree
// unchanged if the target can't be found, rather than throwing. This lets
// callers (PanesView's optimistic-update handlers) invoke these ops
// speculatively — e.g. after a stale re-render — without needing a
// try/catch at every call site. Kept consistent across splitLeaf, closeLeaf,
// swapLeaves, and setRatio.
// ---------------------------------------------------------------------------

import type { SplitDirection, SplitTree } from '@shared/types'

/** A single step of a NODE-ADDRESSING PATH (see setRatio's doc comment
 *  below) — which child, 'a' or 'b', to descend into at one level of the
 *  tree. Distinct from `SplitDirection` ('v'|'h', a node's split
 *  orientation) even though both are two-value string unions; conflating
 *  them here previously caused a real type error (TS2367/TS2322) since
 *  'a'/'b' have no overlap with 'v'/'h'. Exported so SplitTree.tsx and
 *  PanesView.tsx address the same path type this module's setRatio expects. */
export type SplitPathStep = 'a' | 'b'

/** A located leaf: its parent node (null if the leaf is the tree's root) and
 *  which side ('a' or 'b') of that parent it sits on. Shared by closeLeaf
 *  and swapLeaves, which both need to walk to a specific leaf and know how
 *  it's attached to its parent. */
interface LeafLocation {
  parent: { dir: SplitDirection; a: SplitTree; b: SplitTree; ratio: number } | null
  side: 'a' | 'b' | null
}

function isLeaf(tree: SplitTree): tree is { paneId: string } {
  return 'paneId' in tree
}

/** Depth-first search for the leaf whose paneId matches `paneId`. Returns
 *  its LeafLocation, or null if not present anywhere in `tree`. Shared
 *  walker for closeLeaf/swapLeaves so both stay under the cognitive-
 *  complexity cap instead of duplicating the recursion. */
function findLeafLocation(
  tree: SplitTree,
  paneId: string,
  parent: LeafLocation['parent'] = null,
  side: LeafLocation['side'] = null
): LeafLocation | null {
  if (isLeaf(tree)) {
    return tree.paneId === paneId ? { parent, side } : null
  }
  return findLeafLocation(tree.a, paneId, tree, 'a') ?? findLeafLocation(tree.b, paneId, tree, 'b')
}

/**
 * splitLeaf — replace the leaf whose paneId is `paneId` with a new node
 * `{ dir, a: <old leaf>, b: { paneId: newPaneId }, ratio: 0.5 }`, i.e. the
 * split target becomes the first child and the freshly-created pane becomes
 * the second child. Mirrors the mockup's `splitPane`'s `rebuild()`:
 * `node(dir, {pane:t.pane}, fresh, 0.5)`.
 *
 * If `paneId` isn't found anywhere in `tree`, returns `tree` unchanged (see
 * the NOT-FOUND CONVENTION above) — callers should treat this as a no-op,
 * not an error.
 */
export function splitLeaf(
  tree: SplitTree,
  paneId: string,
  dir: SplitDirection,
  newPaneId: string
): SplitTree {
  if (isLeaf(tree)) {
    if (tree.paneId !== paneId) return tree
    return { dir, a: tree, b: { paneId: newPaneId }, ratio: 0.5 }
  }
  const a = splitLeaf(tree.a, paneId, dir, newPaneId)
  if (a !== tree.a) return { ...tree, a }
  const b = splitLeaf(tree.b, paneId, dir, newPaneId)
  if (b !== tree.b) return { ...tree, b }
  return tree
}

/**
 * closeLeaf — remove the leaf whose paneId is `paneId`.
 *
 * - If `tree` is null, returns null (nothing to close).
 * - If the target is the root and the tree's only leaf, returns `null`
 *   (an empty layout — mirrors the mockup: `if (f.tree.pane.id===id)
 *   f.tree=null`).
 * - Otherwise the leaf's parent node collapses to its SIBLING subtree
 *   (which may itself be a whole subtree, not just a leaf) — mirrors the
 *   mockup's `rebuild()`: `if(aLeaf) return t.b; if(bLeaf) return t.a;`.
 *
 * If `paneId` isn't found, returns `tree` unchanged.
 */
export function closeLeaf(tree: SplitTree | null, paneId: string): SplitTree | null {
  if (tree === null) return null
  if (isLeaf(tree)) return tree.paneId === paneId ? null : tree

  // A node whose direct child is the target leaf collapses to the sibling,
  // regardless of whether that sibling is a leaf or a whole subtree.
  if (isLeaf(tree.a) && tree.a.paneId === paneId) return tree.b
  if (isLeaf(tree.b) && tree.b.paneId === paneId) return tree.a

  const a = closeLeaf(tree.a, paneId)
  if (a !== tree.a) return { ...tree, a: a as SplitTree }
  const b = closeLeaf(tree.b, paneId)
  if (b !== tree.b) return { ...tree, b: b as SplitTree }
  return tree
}

/**
 * swapLeaves — exchange the paneId values held at the leaves named `a` and
 * `b`, leaving the tree's shape and every node's ratio untouched. Mirrors
 * the mockup's `swapPanes`: `const pa=A.leaf.pane; ...; A.leaf.pane=pb;
 * B.leaf.pane=pa`.
 *
 * If either id isn't found (or they're the same id), returns `tree`
 * unchanged.
 */
export function swapLeaves(tree: SplitTree, a: string, b: string): SplitTree {
  if (a === b) return tree
  const locA = findLeafLocation(tree, a)
  const locB = findLeafLocation(tree, b)
  if (!locA || !locB) return tree

  // Rebuild bottom-up: rename occurrences of `a` -> `b` and `b` -> `a` at
  // the two leaf sites. A single recursive pass handles both regardless of
  // where each sits relative to the other.
  function rebuild(node: SplitTree): SplitTree {
    if (isLeaf(node)) {
      if (node.paneId === a) return { paneId: b }
      if (node.paneId === b) return { paneId: a }
      return node
    }
    const nextA = rebuild(node.a)
    const nextB = rebuild(node.b)
    if (nextA === node.a && nextB === node.b) return node
    return { ...node, a: nextA, b: nextB }
  }
  return rebuild(tree)
}

/** Lower/upper bounds a divider's ratio may occupy — keeps either side of a
 *  split from being dragged down to zero width. */
const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/**
 * setRatio — set a specific node's ratio, clamped to [0.15, 0.85].
 *
 * NODE-ADDRESSING SCHEME (read this before calling): `nodePath` is an array
 * of 'a'/'b' steps walked from the tree's root. `[]` addresses the root
 * itself (only valid if the root is a node, not a leaf). `['a']` addresses
 * the root's `a` child, if that child is itself a node. `['b','a']`
 * addresses "the root's b child's a child", and so on. A leaf can never be
 * validly addressed this way, since only nodes carry a `ratio` — walking
 * the path into a leaf (or past the end of the tree) means the path doesn't
 * resolve, and the tree is returned unchanged.
 *
 * This is the same addressing scheme SplitTree.tsx's divider drag handler
 * uses to identify which node it's resizing.
 */
export function setRatio(tree: SplitTree, nodePath: SplitPathStep[], ratio: number): SplitTree {
  if (isLeaf(tree)) return tree // path resolved into a leaf — invalid target
  if (nodePath.length === 0) {
    return { ...tree, ratio: clampRatio(ratio) }
  }
  const [step, ...rest] = nodePath
  if (step === 'a') {
    const a = setRatio(tree.a, rest, ratio)
    if (a === tree.a) return tree
    return { ...tree, a }
  }
  const b = setRatio(tree.b, rest, ratio)
  if (b === tree.b) return tree
  return { ...tree, b }
}

/** countLeaves — number of leaves (panes) in the tree; 0 for `null`. Used
 *  to enforce the ≤4-panes-per-layout cap (R6). */
export function countLeaves(tree: SplitTree | null): number {
  if (tree === null) return 0
  if (isLeaf(tree)) return 1
  return countLeaves(tree.a) + countLeaves(tree.b)
}

/** firstLeaf — the paneId of the first (leftmost, depth-first `a`-first)
 *  leaf, or null if the tree is null. Used to pick a default focused pane. */
export function firstLeaf(tree: SplitTree | null): string | null {
  if (tree === null) return null
  if (isLeaf(tree)) return tree.paneId
  return firstLeaf(tree.a) ?? firstLeaf(tree.b)
}

/** leafIds — every paneId in the tree, in depth-first (`a`-then-`b`) order.
 *  Used e.g. to validate a tree against its layout's known terminal rows. */
export function leafIds(tree: SplitTree | null): string[] {
  if (tree === null) return []
  if (isLeaf(tree)) return [tree.paneId]
  return [...leafIds(tree.a), ...leafIds(tree.b)]
}

/** A leaf's position within the stage, expressed as PERCENTAGES of the
 *  stage's own box (not pixels) — so the caller can lay it out with plain
 *  `position:absolute; left/top/width/height: N%` and never re-run this
 *  computation on a resize (percentages track a resizing container for
 *  free; pixel rects would need a ResizeObserver on the STAGE too). */
export interface LeafRect {
  paneId: string
  leftPct: number
  topPct: number
  widthPct: number
  heightPct: number
}

/** The full-stage rect a tree's root starts from — 0/0/100/100. Exported so
 *  callers (SplitTree.tsx) don't need to hand-write this literal. */
export const FULL_STAGE_RECT: LeafRect = {
  paneId: '',
  leftPct: 0,
  topPct: 0,
  widthPct: 100,
  heightPct: 100
}

/**
 * computeLeafRects — flatten a SplitTree into a list of {paneId, rect}
 * pairs, one per leaf, by walking the tree once and subdividing a starting
 * rect (default: the full stage, 0/0/100%/100%) at each node according to
 * its `dir` + `ratio`, exactly the way SplitNode's flexbox layout already
 * subdivides visually:
 *
 *   - 'v' node (side-by-side): splits WIDTH — `a` gets the left
 *     `ratio` share, `b` gets the right `(1 - ratio)` share; both keep the
 *     parent's full height.
 *   - 'h' node (stacked): splits HEIGHT — `a` gets the top `ratio` share,
 *     `b` gets the bottom `(1 - ratio)` share; both keep the parent's full
 *     width.
 *
 * This is the pure geometry backing the FLAT-RENDER fix (Bug #3): instead
 * of recursively nesting a `<PaneCell>` under a `<SplitNode>` div per tree
 * node (which changes a pane's element TYPE/position in the DOM tree every
 * time the tree's shape changes, forcing React to unmount+remount it), the
 * renderer calls this ONCE per tree render to get a flat list, then renders
 * every pane as a sibling `<PaneCell>` positioned absolutely by its rect.
 * Splitting/closing/swapping only ever changes ENTRIES in this flat list
 * (add/remove one, or change existing entries' rect numbers) — the existing
 * entries' React elements never change type or nesting depth, so React
 * never unmounts them.
 *
 * A leaf's own rect is returned verbatim (mirrors the mockup's implicit
 * "the whole node is the cell" for a single-pane layout). Returns `[]` for
 * a `null` tree (empty layout).
 */
export function computeLeafRects(
  tree: SplitTree | null,
  rect0: LeafRect = FULL_STAGE_RECT
): LeafRect[] {
  if (tree === null) return []
  if (isLeaf(tree)) return [{ ...rect0, paneId: tree.paneId }]

  const { leftPct, topPct, widthPct, heightPct } = rect0
  const aShare = clampRatio(tree.ratio)
  const bShare = 1 - aShare

  const [rectA, rectB] =
    tree.dir === 'v'
      ? [
          { ...rect0, widthPct: widthPct * aShare },
          { ...rect0, leftPct: leftPct + widthPct * aShare, widthPct: widthPct * bShare }
        ]
      : [
          { ...rect0, heightPct: heightPct * aShare },
          { ...rect0, topPct: topPct + heightPct * aShare, heightPct: heightPct * bShare }
        ]

  return [...computeLeafRects(tree.a, rectA), ...computeLeafRects(tree.b, rectB)]
}
