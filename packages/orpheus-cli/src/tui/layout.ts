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

const ELLIPSIS = '…'

/** Hard-truncate `name` to at most `width` chars, appending an ellipsis when cut. */
export function truncate(name: string, width: number): string {
  if (width <= 0) return ''
  if (name.length <= width) return name
  if (width === 1) return ELLIPSIS
  return name.slice(0, width - 1) + ELLIPSIS
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
        tmuxHosted: node.ws.tmuxHosted === true
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
