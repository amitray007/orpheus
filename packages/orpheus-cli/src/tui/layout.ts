/**
 * tui/layout.ts — pure, dependency-free layout logic for `orpheus tui`.
 *
 * Nothing in this file imports react/ink/node builtins — it's plain data in,
 * plain data out, so it can be exercised head-on by
 * scripts/verify-tui-layout.ts with no TTY/Electron/DB involved. Ink
 * components (tui/App.tsx and friends) are thin consumers of these functions;
 * they must not duplicate this logic.
 *
 * See docs/TUI_SPEC.md ("Layout" + "Keymap" sections) for the design this
 * implements.
 */

import stringWidth from 'string-width'
import type { TreeFrame, TreeProject, TreeWorkspace, WorkspaceStatus } from './types.js'

// ---------------------------------------------------------------------------
// Glyphs — single-width only (see docs/TUI_SPEC.md: no emoji, meaning is
// carried by colour, glyphs just disambiguate for colour-blind/no-colour
// terminals).
// ---------------------------------------------------------------------------

export const ATTENTION_GLYPH = '!'
export const WORKING_GLYPH = '●'
export const IDLE_GLYPH = '○'
export const WORKTREE_GLYPH = '»'
export const CHILD_INDENT = '└ '

/** Status → single-width glyph. awaiting_input and idle intentionally share
 * a glyph (both "nothing to do right now") — they're told apart by colour,
 * not shape, per the spec's "meaning carried by colour" rule. */
export function statusGlyph(status: WorkspaceStatus): string {
  if (status === 'attention') return ATTENTION_GLYPH
  if (status === 'in_progress') return WORKING_GLYPH
  return IDLE_GLYPH
}

/** True for the statuses that count as "active" under the default `active` filter. */
export function isActiveStatus(status: WorkspaceStatus): boolean {
  return status === 'attention' || status === 'in_progress'
}

// ---------------------------------------------------------------------------
// Breakpoints + column plan
// ---------------------------------------------------------------------------

export type Breakpoint = 'narrow' | 'medium' | 'wide'

/** narrow <52, medium 52..103, wide >=104 (docs/TUI_SPEC.md "Layout"). */
export function resolveBreakpoint(columns: number): Breakpoint {
  if (columns < 52) return 'narrow'
  if (columns <= 103) return 'medium'
  return 'wide'
}

export interface ColumnPlan {
  /** Width reserved for the flat "N" index (right-aligned). */
  numWidth: number
  /** Width reserved for the status glyph + one separating space. */
  glyphWidth: number
  /** Width available for the (possibly truncated) workspace/project name. */
  nameWidth: number
  /** Width reserved for the worktree-marker column (0 on narrow — hidden). */
  worktreeWidth: number
  /** Width reserved for a textual status word (0 below `wide` — glyph-only). */
  statusWidth: number
  /** Total columns this plan consumes. */
  total: number
}

/** Never truncate the name column narrower than this, even on a tiny terminal. */
const MIN_NAME_WIDTH = 4

const FIXED_WIDTHS: Record<
  Breakpoint,
  { num: number; glyph: number; worktree: number; status: number }
> = {
  // 44-col reference layout (iPhone portrait, keyboard up): digits + glyph +
  // name only — no room for a worktree column or a spelled-out status word.
  narrow: { num: 3, glyph: 2, worktree: 0, status: 0 },
  // 80-col reference layout: room for the worktree marker, still glyph-only status.
  medium: { num: 4, glyph: 2, worktree: 2, status: 0 },
  // 104-col reference layout: full detail, including a spelled-out status word.
  wide: { num: 4, glyph: 2, worktree: 2, status: 12 }
}

/**
 * Compute the per-column character widths for `columns` at the given
 * breakpoint. `total` always equals `columns` exactly as long as the name
 * column doesn't hit its MIN_NAME_WIDTH floor (i.e. columns is comfortably
 * above the breakpoint's fixed overhead) — below that floor the plan
 * degrades gracefully (total may exceed columns; callers just get a name
 * column that's as narrow as it can reasonably go).
 */
export function columnPlanFor(breakpoint: Breakpoint, columns: number): ColumnPlan {
  const fixed = FIXED_WIDTHS[breakpoint]
  const fixedTotal = fixed.num + fixed.glyph + fixed.worktree + fixed.status
  const nameWidth = Math.max(MIN_NAME_WIDTH, columns - fixedTotal)
  return {
    numWidth: fixed.num,
    glyphWidth: fixed.glyph,
    nameWidth,
    worktreeWidth: fixed.worktree,
    statusWidth: fixed.status,
    total: fixed.num + fixed.glyph + nameWidth + fixed.worktree + fixed.status
  }
}

// ---------------------------------------------------------------------------
// Truncation — hard truncate, never wrap
// ---------------------------------------------------------------------------

// Three ASCII dots, NOT the single-character U+2026 HORIZONTAL ELLIPSIS this
// used to be. U+2026 is East_Asian_Width=Ambiguous (verified against
// Unicode's own EastAsianWidth.txt: `2024..2027 ; A # Po [4] ONE DOT
// LEADER..HYPHENATION POINT`) — on a terminal configured for CJK it renders
// as TWO columns, silently under-reserving the truncation budget by one
// column and overflowing every truncated title's column budget by 1. `.`
// U+002E is confirmed Narrow (`002E..002F ; Na # Po [2] FULL STOP..SOLIDUS`),
// so three of them are unambiguously 3 columns everywhere.
const ELLIPSIS = '...'

/**
 * Hard-truncate `name` to at most `width` TERMINAL COLUMNS, appending an
 * ellipsis when cut. Uses `string-width` (already an installed dependency of
 * `ink`, transitively reachable from this package without a package.json
 * edit) for measurement because JS string `.length` counts UTF-16 code
 * units, not display columns:
 * wide CJK/fullwidth characters are 1 `.length` unit but 2 terminal columns,
 * which would silently corrupt column alignment for real Claude-set OSC
 * titles (arbitrary text, not guaranteed ASCII). For pure-ASCII input
 * (`.length` charcount == display width), this produces byte-for-byte the
 * same output as the old plain char-count implementation it replaces.
 */
export function truncate(name: string, width: number): string {
  if (width <= 0) return ''
  if (stringWidth(name) <= width) return name
  // A 3-char ellipsis doesn't fit in a 1- or 2-column budget the way the old
  // 1-char '…' always did — degrade to as many literal dots as fit rather
  // than returning the full '...' when it wouldn't fit.
  if (width < ELLIPSIS.length) return ELLIPSIS.slice(0, width)
  // Walk code points (`for...of` iterates by code point, never splitting a
  // surrogate pair) accumulating display width, reserving exactly
  // ELLIPSIS.length columns for the trailing ellipsis.
  const budget = width - ELLIPSIS.length
  let out = ''
  let used = 0
  for (const ch of name) {
    const w = stringWidth(ch)
    if (used + w > budget) break
    out += ch
    used += w
  }
  return out + ELLIPSIS
}

// ---------------------------------------------------------------------------
// flattenTree — tree frame -> ordered, numbered, filtered display rows
// ---------------------------------------------------------------------------

export type Filter = 'active' | 'all'

/** `--project` scoping: narrows to one project and suppresses its header row. */
export interface ProjectScope {
  id: string
  name: string
}

export type DisplayRow =
  | {
      kind: 'project-header'
      projectId: string
      projectName: string
      cwd: string
    }
  | {
      kind: 'workspace'
      /** Flat 1..N index across ALL projects — headers never consume a number. */
      index: number
      workspaceId: string
      projectId: string
      name: string
      status: WorkspaceStatus
      waitingFor: string | null
      /** 0 = top-level workspace; 1+ = nested under a parent workspace. */
      depth: number
      worktreeBranch: string | null
      tmuxHosted: boolean
      /**
       * Optional passthrough of the wire frame's `lastActivityAt` — ADDITIVE
       * field for the tui-otui redesign's right-aligned age column
       * (docs/TUI_UI_REDESIGN.md ghui device #5) and wide-tier detail pane.
       * Optional and unread by the Ink build (tui/App.tsx,
       * tui/components/WorkspaceRow.tsx) — flattenForest() below populates
       * it whenever the source TreeWorkspace carries it, but no Ink-side
       * consumer reads this field, so its presence is a pure addition, not a
       * shape change existing Ink call sites need to handle.
       */
      lastActivityAt?: number | null
      /**
       * Optional passthrough of the wire frame's `lastTitle` — the live OSC
       * terminal title Claude Code sets while working, mirrored from
       * `WorkspaceRecord.lastTitle`. ADDITIVE field following the exact
       * precedent set by `lastActivityAt` above: optional, populated by
       * flattenForest() below whenever the source TreeWorkspace carries it,
       * and safe for the Ink build to ignore if it chooses not to read it.
       * Use `displayTitleFor()` (below) to resolve the row's actual label —
       * never read `lastTitle` directly for display.
       */
      lastTitle?: string | null
    }

/**
 * Resolve what a workspace row should actually show as its primary label:
 * the live terminal title when one has been set (trimmed, non-empty), else
 * the workspace's own `name`. Centralizing this here (rather than in each
 * renderer) keeps the fallback rule identical across tui/ and tui-otui/.
 */
export function displayTitleFor(row: { name: string; lastTitle?: string | null }): string {
  const t = row.lastTitle?.trim()
  return t != null && t.length > 0 ? t : row.name
}

export interface FlattenResult {
  rows: DisplayRow[]
  /** Workspaces hidden by the active filter, across all in-scope projects. */
  hiddenCount: number
  /** Workspaces shown after filtering (== number of 'workspace' rows). */
  visibleCount: number
  /** Total in-scope workspace count, before filtering. */
  totalCount: number
}

interface ForestNode {
  ws: TreeWorkspace
  children: ForestNode[]
}

function statusPriority(status: WorkspaceStatus): number {
  if (status === 'attention') return 0
  if (status === 'in_progress') return 1
  if (status === 'awaiting_input') return 2
  return 3 // idle (and any future/unknown status — treated as least urgent)
}

/** Attention-first, then sortOrder asc (nulls last), then name — stable + deterministic. */
function sortSiblings(list: TreeWorkspace[]): TreeWorkspace[] {
  return [...list].sort((a, b) => {
    const priorityDelta = statusPriority(a.status) - statusPriority(b.status)
    if (priorityDelta !== 0) return priorityDelta
    const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER
    const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER
    if (sa !== sb) return sa - sb
    return a.name.localeCompare(b.name)
  })
}

/**
 * Reconstruct the parent/child forest from a project's FLAT workspace array
 * (the wire format carries `parentWorkspaceId`, not nesting — see
 * docs/TUI_SPEC.md's `tree` frame example). A workspace whose parent id is
 * missing or doesn't resolve within this project is treated as a root
 * (defensive — mirrors the main process's own dangling-parent handling).
 */
function buildForest(workspaces: TreeWorkspace[]): ForestNode[] {
  const byId = new Set(workspaces.map((w) => w.id))
  const childrenByParent = new Map<string, TreeWorkspace[]>()
  const roots: TreeWorkspace[] = []

  for (const ws of workspaces) {
    const parentId = ws.parentWorkspaceId
    if (parentId != null && byId.has(parentId)) {
      const siblings = childrenByParent.get(parentId)
      if (siblings != null) siblings.push(ws)
      else childrenByParent.set(parentId, [ws])
    } else {
      roots.push(ws)
    }
  }

  const build = (ws: TreeWorkspace): ForestNode => ({
    ws,
    children: sortSiblings(childrenByParent.get(ws.id) ?? []).map(build)
  })

  return sortSiblings(roots).map(build)
}

/** Mutable counters threaded through the recursive flatten pass. */
interface FlattenCounters {
  nextIndex: number
  hidden: number
  total: number
}

function flattenForest(
  forest: ForestNode[],
  projectId: string,
  filter: Filter,
  depth: number,
  counters: FlattenCounters,
  out: DisplayRow[]
): void {
  for (const node of forest) {
    counters.total++
    const visible = filter === 'all' || isActiveStatus(node.ws.status)
    if (visible) {
      out.push({
        kind: 'workspace',
        index: counters.nextIndex++,
        workspaceId: node.ws.id,
        projectId,
        name: node.ws.name,
        status: node.ws.status,
        waitingFor: node.ws.waitingFor ?? null,
        depth,
        worktreeBranch: node.ws.worktreeBranch ?? null,
        tmuxHosted: node.ws.tmuxHosted === true,
        lastActivityAt: node.ws.lastActivityAt ?? null,
        lastTitle: node.ws.lastTitle ?? null
      })
    } else {
      counters.hidden++
    }
    // Children are walked regardless of the parent's own visibility — an
    // active child must never be hidden just because its parent isn't.
    flattenForest(node.children, projectId, filter, depth + 1, counters, out)
  }
}

/**
 * Turn a `tree` frame into ordered display rows: flat 1..N numbering across
 * ALL in-scope projects, attention-first sibling ordering, project header
 * rows (unless `scope` narrows to a single project, per the `--project`
 * flag — see docs/TUI_SPEC.md and the tui.ts command), and child-workspace
 * depth for indentation.
 */
export function flattenTree(frame: TreeFrame, filter: Filter, scope?: ProjectScope): FlattenResult {
  const rows: DisplayRow[] = []
  const counters: FlattenCounters = { nextIndex: 1, hidden: 0, total: 0 }

  const projects: TreeProject[] =
    scope != null ? frame.projects.filter((p) => p.id === scope.id) : frame.projects

  for (const project of projects) {
    const forest = buildForest(project.workspaces)
    const projectRows: DisplayRow[] = []
    flattenForest(forest, project.id, filter, 0, counters, projectRows)

    // Single-project mode (--project) suppresses the header: there's only
    // ever one project on screen, so the row is wasted vertical space.
    if (scope == null) {
      rows.push({
        kind: 'project-header',
        projectId: project.id,
        projectName: project.name,
        cwd: project.cwd
      })
    }
    rows.push(...projectRows)
  }

  return {
    rows,
    hiddenCount: counters.hidden,
    visibleCount: counters.nextIndex - 1,
    totalCount: counters.total
  }
}

// ---------------------------------------------------------------------------
// Viewport windowing — render only the rows that fit in the terminal's
// current row count, keeping the selected row in view with a scroll-off
// margin. Pure function: no Ink, no process.stdout reads — App.tsx supplies
// `availableRows` (derived from process.stdout.rows) and the currently
// highlighted row index.
// ---------------------------------------------------------------------------

export interface ScrollWindow {
  /** Slice of `rows` that should actually be rendered this frame. */
  visible: DisplayRow[]
  /** Count of rows scrolled off above the visible slice (0 if none). */
  aboveCount: number
  /** Count of rows scrolled off below the visible slice (0 if none). */
  belowCount: number
  /**
   * True once windowing is engaged at all (rows.length > availableRows).
   * Callers should render BOTH scroll affordance rows whenever this is
   * true — always mounted, colored bright/dim by whether aboveCount/
   * belowCount is > 0 — rather than conditionally mounting only the
   * direction that currently has something scrolled off. Conditionally
   * MOUNTING causes a real layout jump: reserving a variable 0/1/2
   * affordance rows depending on scroll position means the content
   * window's own height changes the instant you scroll past the top/
   * bottom edge, visibly reflowing every row on screen. Reserving a FIXED
   * 2-row affordance budget for the whole scrolling session (recoloring,
   * never remounting) keeps the content window's height constant.
   */
  windowed: boolean
}

/** Rows spent on the "more above/below" affordances once scrolling is
 * engaged at all — always both, so the content window's height never
 * changes mid-scroll (see ScrollWindow.windowed's doc comment). */
const AFFORDANCE_ROWS_WHEN_WINDOWED = 2

/**
 * Keep `selectedIndex` (an index into `rows`, not the display `index`
 * field — this operates on already-flattened DisplayRow position) within a
 * window of `availableRows` lines, biasing toward keeping a few rows of
 * context around the selection rather than pinning it to an edge.
 *
 * `availableRows` is the full budget INCLUDING space for the affordance
 * lines — this function decides internally whether affordance rows are
 * reserved at all (only when windowing engages) and shrinks the content
 * slice accordingly, so callers never have to pre-compute that themselves.
 */
export function scrollWindowFor(
  rows: DisplayRow[],
  selectedIndex: number,
  availableRows: number
): ScrollWindow {
  if (availableRows <= 0 || rows.length === 0) {
    return { visible: [], aboveCount: rows.length, belowCount: 0, windowed: rows.length > 0 }
  }
  if (rows.length <= availableRows) {
    return { visible: rows, aboveCount: 0, belowCount: 0, windowed: false }
  }

  // Windowing is engaged: reserve the FULL fixed affordance budget up
  // front (never recomputed from the current scroll position), so the
  // content window's height is constant for the whole scrolling session.
  const capacity = Math.max(1, availableRows - AFFORDANCE_ROWS_WHEN_WINDOWED)
  const start = clampWindowStart(selectedIndex, rows.length, capacity)
  const end = Math.min(rows.length, start + capacity)

  return {
    visible: rows.slice(start, end),
    aboveCount: start,
    belowCount: rows.length - end,
    windowed: true
  }
}

/** Scroll-off margin: how many rows of context to keep around the selection
 * when it's not near either edge of the full list. */
const SCROLL_OFF = 1

function clampWindowStart(selectedIndex: number, totalRows: number, capacity: number): number {
  const maxStart = Math.max(0, totalRows - capacity)
  const desired = selectedIndex - Math.min(SCROLL_OFF, Math.floor((capacity - 1) / 2))
  return Math.min(maxStart, Math.max(0, desired))
}
