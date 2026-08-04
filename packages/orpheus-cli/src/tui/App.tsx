/**
 * tui/App.tsx — the Ink root component for `orpheus tui`.
 *
 * CARD REDESIGN — ONE LAYOUT, NOT THREE (port of tui-otui/App.tsx's Solid
 * version — see that file's header for the fuller design rationale this
 * preserves verbatim, translated to React/Ink)
 * -----------------------------------------------------------------------
 * Every breakpoint renders the list body with the same 3-line WorkspaceCard
 * (see components/WorkspaceCard.tsx), grouped by project
 * (ProjectGroupHeader) — one layout that breathes (spacing grows with
 * width) rather than reflowing into a different shape. The only
 * breakpoint-conditional structure is the wide-tier (>=120 cols)
 * master/detail split: cards on the left, DetailPane (whose own left border
 * draws the divider) on the right.
 *
 * BREAKPOINT RESOLUTION — cardBreakpoints.ts, NOT layout.ts's
 * resolveBreakpoint. The two disagree on where "narrow" ends (59 vs 51) —
 * see cardBreakpoints.ts's file header for the real gap this closes.
 *
 * VARIABLE-HEIGHT BLOCK WINDOWING — blocks.ts's buildBlocks()/windowBlocks(),
 * NOT layout.ts's scrollWindowFor (which assumes one row per DisplayRow and
 * cannot window 3-line cards). flattenTree() from layout.ts is still reused
 * unchanged for the row list itself (project grouping, attention-first
 * sibling ordering, active-filter, flat numbering).
 *
 * MODEL/EFFORT/GITBRANCH LOOKUP — layout.ts's DisplayRow (workspace variant)
 * doesn't carry model/effort/gitBranch. `workspaceById` below builds a flat
 * `workspaceId -> TreeWorkspace` lookup directly from the raw `frame`
 * (frameStore's snapshot), which DOES carry these fields (see types.ts).
 * WorkspaceCard/DetailPane receive them as separate props from this lookup,
 * not from the `row` prop.
 *
 * SOLID -> REACT TRANSLATION: THE STICKY WINDOW START
 * -----------------------------------------------------------------------
 * tui-otui/App.tsx holds `windowStartIndex` in a Solid signal, written back
 * from a `createEffect` that reacts to the windowing memo's OWN computed
 * `start` (not `windowStartIndex()` itself, to avoid a self-referential
 * cycle). A naive React port using `useEffect` to mirror that write-back
 * would render ONE FRAME with the STALE window before the effect fires
 * (effects run after paint), visible as a one-frame flash of the wrong
 * window on selection changes that cross a window boundary. A ref mutated
 * during render was tried first but rejected: this repo's `react-hooks/refs`
 * lint rule (React Compiler's ESLint plugin) hard-errors on both reading
 * and writing a ref's `.current` during render, since it can't verify the
 * safety invariant a human reviewer could. Fixed instead with React's own
 * documented "adjust state during render" pattern: `windowStart` is
 * `useState`, and calling its setter mid-render — when the freshly computed
 * `windowBlocks().start` differs from the current state — triggers an
 * immediate re-render before paint (React bails out of committing the
 * stale render), converging in the same tick with no visible flash and no
 * extra effect pass.
 *
 * Terminal dimensions come from Ink 7's native `useWindowSize()`.
 */

import * as React from 'react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import {
  displayTitleFor,
  flattenTree,
  type Breakpoint,
  type DisplayRow,
  type Filter,
  type ProjectScope
} from './layout.js'
import { CARD_MEDIUM_MAX, resolveCardBreakpoint } from './cardBreakpoints.js'
import { buildBlocks, windowBlocks, type Block, type SelectedBlockId } from './blocks.js'
import { frameStore } from './frameStore.js'
import { connectionStore } from './connectionStore.js'
import { sendCommand } from '../socket-client.js'
import { TitleBar } from './components/TitleBar.js'
import { Footer } from './components/Footer.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { ProjectGroupHeader } from './components/ProjectGroupHeader.js'
import { WorkspaceCard } from './components/WorkspaceCard.js'
import { ScrollAffordance } from './components/ScrollAffordance.js'
import { DetailPane } from './components/DetailPane.js'
import { NewWorkspaceWizard } from './components/NewWorkspaceWizard.js'
import { CloseArchiveConfirm, type ArchiveStage } from './components/CloseArchiveConfirm.js'
import { AddProjectPrompt } from './components/AddProjectPrompt.js'
import { activePalette, VRULE_PAD_X, CARD_SEPARATOR_ROWS } from './theme.js'
import type { Palette } from './theme.js'
import type { TreeProject, TreeWorkspace } from './types.js'
import type { WizardProject } from './wizardTypes.js'

export interface AppProps {
  /** Set when `--project` narrows the picker to a single project. */
  scope?: ProjectScope
  /**
   * Initial `view` filter — defaults to 'all' below via ??, but entry.ts
   * (whose `runTui()` loop remounts a fresh <App> on every picker<->tmux
   * round trip — see that file's header) feeds in whatever the user last
   * had selected so re-opening the picker after a detach doesn't silently
   * reset the filter out from under them.
   */
  initialView?: Filter
  /**
   * Initial selection, by workspace id — same round-trip motivation as
   * `initialView`. Deliberately typed and threaded exactly like the `null`
   * default it replaces (a possibly-stale raw id): `selectedRowIndex` below
   * already resolves this against the CURRENT frame and falls back to index
   * 0 if the id isn't present, so a stale id from a since-archived/renamed
   * workspace degrades gracefully with no extra handling here.
   */
  initialSelectedWorkspaceId?: string | null
  onOpen: (workspaceId: string) => void
  onQuit: () => void
  /**
   * Fired whenever the RESOLVED view/selection changes, so entry.ts can
   * remember them across `runPickerOnce()` calls. Reports the derived
   * `selectedWorkspaceId` (post stale-id-fallback), never the raw
   * `selectedWorkspaceIdRaw` state — echoing the raw value back would let a
   * stale id that already fell back to index 0 get persisted as if it were
   * still valid, defeating the fallback the next time around.
   */
  onSelectionChange?: (view: Filter, selectedWorkspaceId: string | null) => void
}

const FOOTER_ROWS = 1
const DETAIL_PANE_WIDTH = 42
const VRULE_WIDTH = 1 + VRULE_PAD_X
/** Blank columns held inside each terminal edge. Applied once on the root
 *  frame so the title bar, cards, detail pane and footer all clear the
 *  border by the same amount — no element renders flush against it. */
const FRAME_PAD_X = 1
/** Every workspace card is exactly this many terminal rows — see
 *  blocks.ts's file header for why this is a caller-supplied parameter
 *  rather than a constant baked into that module. */
/** Card rows: 3 lines of content + 1 leading separator ABOVE each card that
 *  rules it off from the PREVIOUS card.
 *
 *  Without the separator, consecutive cards butt directly against each other
 *  and a list of four reads as one unbroken 12-line block — the selection
 *  rail marks which card is current, but nothing marks where any OTHER card
 *  starts or ends. The row is part of the card's own height (rather than a
 *  gap the list inserts between siblings) so blocks.ts's windowing
 *  arithmetic stays a simple sum and a partially-scrolled card can never
 *  strand its separator on its own. `CARD_HEIGHT` is what every card gets
 *  EXCEPT the first in its project group — that card has no previous card to
 *  rule off (the project header sits above it instead), so buildBlocks()
 *  gives it `CARD_HEIGHT - CARD_SEPARATOR_ROWS` rows instead of reserving a
 *  row it would only ever render blank. See blocks.ts's own doc comment on
 *  `firstCardHeightDelta`. */
const CARD_CONTENT_ROWS = 3
const CARD_HEIGHT = CARD_CONTENT_ROWS + CARD_SEPARATOR_ROWS
/** Master/detail split engages at this width — one more than
 *  cardBreakpoints.ts's own CARD_MEDIUM_MAX, so this can never drift out of
 *  sync with resolveCardBreakpoint()'s own wide-tier threshold the way the
 *  hardcoded 120 previously could (see cardBreakpoints.ts's file header for
 *  the bug that caused). */
const WIDE_MIN_COLUMNS = CARD_MEDIUM_MAX + 1
/** How long the Footer's transient notice (`closed <name>`, or a failed `o`
 *  sort's error text) stays up before auto-clearing — see the
 *  `footerNotice` state's own doc comment for why this exists at all. Long
 *  enough to read on a phone-width terminal, short enough that it doesn't
 *  linger and get mistaken for permanent chrome. */
const FOOTER_NOTICE_MS = 3000
/** How often the picker repaints purely to advance the rendered ages — see
 *  the age-ticker effect in App() for why a local timer (rather than a
 *  server-side frame) is the right place to fix a frozen age.
 *
 *  1s, NOT a coarser interval: formatAge() (format.ts) renders whole
 *  SECONDS below the one-minute mark ("0s", "1s", ... "59s"), so anything
 *  slower than 1s visibly freezes a freshly-created workspace — the exact
 *  case where the user is most likely to be watching. An earlier revision
 *  used 30s on the reasoning that the label "only changes once a minute";
 *  that is true from one minute onward and plainly false before it, which
 *  is when a new workspace is on screen. Above a minute the extra ticks
 *  merely recompute an unchanged string, which is far cheaper than the
 *  frame it would otherwise take to notice. */
const AGE_TICK_MS = 1_000

type WorkspaceDisplayRow = Extract<DisplayRow, { kind: 'workspace' }>
type ProjectHeaderDisplayRow = Extract<DisplayRow, { kind: 'project-header' }>

/** Shared discriminant literal for the 'project-header' row/block/selection
 *  kind — hoisted so the several runtime comparisons against it below read
 *  as one shared constant rather than sonarjs/no-duplicate-string's 5+
 *  independently-typed repeats of the same string. `as const` preserves the
 *  literal type so it still narrows a discriminated union exactly like the
 *  inline string it replaces. */
const PROJECT_HEADER_KIND = 'project-header' as const

/**
 * SELECTABLE ROWS — the caret's actual traversal order.
 *
 * Historically this was just `workspaceRows` (every 'workspace' DisplayRow,
 * in flattened order) — a project header was never itself a stop, since
 * every project always had at least one card under it to land on instead.
 * That stopped holding once blocks.ts started rendering EMPTY groups (see
 * its "EMPTY GROUPS RENDER THEIR HEADER" note): a project with zero
 * surviving workspace rows contributes a header and nothing else, so if the
 * caret still only ever visited 'workspace' rows, that project's header
 * would render but could never be highlighted — reachable to the eye, not
 * to `j`/`k`, and therefore still unusable as `n`'s inferred target.
 *
 * Fixed by widening the traversal to include project-header rows, but ONLY
 * when that header's own project has zero visible workspace rows —
 * `visibleCount === 0` mirrors blocks.ts's own `isEmpty` (both are derived
 * from the identical flattenTree() per-project count, so they can never
 * disagree about which projects qualify). A non-empty project's header is
 * still never a stop; its cards are. This keeps the existing j/k rhythm over
 * a normal, fully-populated list completely unchanged — the header only
 * enters the traversal for the specific projects that would otherwise have
 * no selectable row at all.
 */
type SelectableRow =
  | { kind: 'workspace'; row: WorkspaceDisplayRow }
  | { kind: 'project-header'; row: ProjectHeaderDisplayRow }

function selectableRowId(row: SelectableRow): SelectedBlockId {
  return row.kind === 'workspace'
    ? { kind: 'workspace', workspaceId: row.row.workspaceId }
    : { kind: PROJECT_HEADER_KIND, projectId: row.row.projectId }
}

/** Structural equality for two `SelectedBlockId`s — used to find which
 *  `selectableRows` entry (if any) a raw selection currently resolves to.
 *  Plain `===` doesn't work since these are freshly-constructed objects, not
 *  interned values. */
function sameSelection(a: SelectedBlockId, b: SelectedBlockId): boolean {
  if (a == null || b == null) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'workspace' && b.kind === 'workspace'
    ? a.workspaceId === b.workspaceId
    : a.kind === PROJECT_HEADER_KIND && b.kind === PROJECT_HEADER_KIND
      ? a.projectId === b.projectId
      : false
}

/** Reserved rows above the scrolling body: TitleBar is 1 row at narrow, 2 at
 *  medium/wide (title row + a blank line — see TitleBar.tsx). Footer is
 *  always 1 row. */
function headerReservedFor(): number {
  // Title row + its full-width nav rule. Was briefly 1 (a blank second row
  // was removed as dead space); the rule reclaims that row for something
  // that actually delimits the bar.
  return 2
}

/** `v`'s cycle order: all -> active -> used -> all. Kept as an explicit
 *  lookup rather than a chain of ternaries so a future 4th filter is a
 *  one-line addition here instead of a re-derivation of the whole chain. */
const VIEW_CYCLE: Record<Filter, Filter> = {
  all: 'active',
  active: 'used',
  used: 'all'
}

/**
 * Handles a single non-navigation, non-quit, non-help keypress: view
 * cycling. Extracted from the main useInput callback to keep its cognitive
 * complexity down (mirrors the pre-redesign App.tsx's handleActionKey).
 */
function handleViewKey(input: string, setView: React.Dispatch<React.SetStateAction<Filter>>): void {
  if (input === 'v') {
    setView((f) => VIEW_CYCLE[f])
  }
}

/**
 * Handles `n` (open the new-workspace wizard) — extracted from the main
 * useInput callback for the same cognitive-complexity reason as
 * handleViewKey above; this one specifically pulled App's useInput handler
 * over the sonarjs/cognitive-complexity budget (20) once the wizard's
 * open/close branch was added inline.
 *
 * Project is inferred from the currently-highlighted row — the task spec is
 * explicit that there's no project-picker step. `selectedProject` (App.tsx's
 * memo) resolves this for BOTH a highlighted workspace card AND a
 * highlighted empty-project header — see blocks.ts's "EMPTY GROUPS RENDER
 * THEIR HEADER" note: a project with zero workspaces (freshly added via
 * `project.add`, or every one filtered out under view:active) is now always
 * reachable as a selectable header row, so this is no longer the dead end
 * an earlier revision of this comment described. `selectedProject == null`
 * only happens when the WHOLE list is empty (zero registered projects) —
 * there is genuinely nothing to infer a project from, so `n` stays a no-op.
 */
function handleNewWorkspaceKey(
  selectedProject: TreeProject | null,
  setWizardProject: React.Dispatch<React.SetStateAction<WizardProject | null>>
): void {
  if (selectedProject == null) return
  const { id, name, cwd } = selectedProject
  setWizardProject({ id, name, cwd })
}

/**
 * Handles `p` (open the add-project overlay) — extracted for the same
 * cognitive-complexity reason as handleViewKey/handleNewWorkspaceKey above.
 * Unlike `n`, this needs no currently-selected row/project: adding a project
 * by path is meaningful even with an empty picker (a brand-new install with
 * zero registered projects), so this is unconditional — just flips the
 * overlay open.
 */
function handleAddProjectKey(
  setAddProjectOpen: React.Dispatch<React.SetStateAction<boolean>>
): void {
  setAddProjectOpen(true)
}

/**
 * Handles `o` (re-sort projects by activity) — extracted for the same
 * cognitive-complexity reason as the handlers above. Unlike `n`/`c`/`a`, this
 * needs no currently-selected row: it re-sorts the WHOLE project list, not
 * one project, mirroring the desktop's own sort button (Dashboard.tsx's
 * handleReorderProjectsByActivity), which also takes no per-row context.
 *
 * Fires 'project.reorderByActivity' — the command-socket action added
 * alongside this handler (see commandServer.ts) that calls the exact same
 * reorderProjectsByActivity() (src/main/projects.ts) the desktop's sort
 * button calls, so the ranking logic (best non-active workspace status wins,
 * projects with none rank last, pinned/unpinned tiers never merge) can never
 * drift between the two surfaces. No local optimistic reorder here (unlike
 * Dashboard.tsx's handleReorderProjectsByActivity, which patches its own
 * `projects` state from the response) — App.tsx never held its own copy of
 * project order to begin with; flattenTree() already re-derives row order
 * from `frame.projects` fresh on every frame, and reorderProjectsByActivity()
 * itself broadcasts projects:changed per project (see that function's own
 * comment), so the NEXT /subscribe tree frame (at most one TREE_POLL_MS poll
 * tick away) carries the new sort_order with no client-side merge needed.
 *
 * On failure, surfaces the error via the Footer's transient notice slot
 * (showFooterNotice — see that state's own doc comment) rather than
 * swallowing it: a sort that silently no-ops would look identical to one
 * that ran and found nothing to reorder, which is indistinguishable from
 * "did this even do anything?" without an explicit signal either way.
 */
function handleSortKey(showFooterNotice: (text: string) => void): void {
  sendCommand('project.reorderByActivity', {}).catch((err: unknown) => {
    showFooterNotice(`sort failed: ${errorMessage(err)}`)
  })
}

/**
 * State for the close/archive confirm overlay (App.tsx-owned, not the new
 * component's own — mirrors `wizardProject` above: a single nullable slot,
 * flipped null<->non-null by App.tsx, with the confirm component itself
 * owning no persistent state of its own beyond what's threaded in as props).
 *
 * `mode`/`archiveStage` together resolve which of CloseArchiveConfirm's
 * three screens (close / archive-confirm / archive-execute) is showing —
 * see that component's file header for the full stage-machine rationale.
 * `submitting`/`submitError` mirror the new-workspace wizard's own
 * submit-state fields (wizard/WizardScreens.tsx's `SubmitStatusLine`) so the
 * async sendCommand + inline-error UX is the same shape as the wizard's
 * already-established pattern.
 */
interface CloseArchiveState {
  workspaceId: string
  workspaceName: string
  worktreeBranch: string | null
  mode: 'close' | 'archive'
  archiveStage: ArchiveStage
  submitting: boolean
  submitError: string | null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Handles `c` (open the close confirm) and `a` (open the archive confirm,
 * stage 'confirm') — extracted from the main useInput callback for the same
 * cognitive-complexity reason as handleViewKey/handleNewWorkspaceKey above.
 * Operates on the currently-highlighted row, exactly like `n` operates on
 * the currently-highlighted row's project. A no-op with nothing selected
 * (empty list / filtered-empty), same defensive shape as
 * handleNewWorkspaceKey's `selectedProject == null` guard.
 *
 * Reached from two unshifted keys — `c` (close) and `a` (archive) — which
 * are deliberately distinct letters rather than a shifted pair; see
 * useInput's own comment for why a phone-first keymap can't put the
 * reversible and the permanent action one shift apart.
 */
function handleCloseArchiveKey(
  mode: 'close' | 'archive',
  selectedRow: WorkspaceDisplayRow | null,
  setCloseArchive: React.Dispatch<React.SetStateAction<CloseArchiveState | null>>
): void {
  if (selectedRow == null) return
  setCloseArchive({
    workspaceId: selectedRow.workspaceId,
    workspaceName: displayTitleFor(selectedRow),
    worktreeBranch: selectedRow.worktreeBranch,
    mode,
    archiveStage: 'confirm',
    submitting: false,
    submitError: null
  })
}

interface PickerBodyProps {
  windowedBlocks: ReturnType<typeof windowBlocks>
  cardAreaWidth: number
  selectedBlockId: SelectedBlockId
  selectedRow: WorkspaceDisplayRow | null
  selectedProjectName: string | null
  workspaceById: Map<string, TreeWorkspace>
  isWide: boolean
  availableRows: number
  palette: Palette
}

/**
 * The card list + (at wide) detail pane split — extracted from App() itself
 * so the map/conditional nesting doesn't count against App()'s own
 * cognitive-complexity budget (sonarjs/cognitive-complexity, capped at 20).
 */
function PickerBody({
  windowedBlocks,
  cardAreaWidth,
  selectedBlockId,
  selectedRow,
  selectedProjectName,
  workspaceById,
  isWide,
  availableRows,
  palette
}: PickerBodyProps): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Box flexDirection="column">
        {windowedBlocks.windowed ? (
          <ScrollAffordance count={windowedBlocks.aboveCount} direction="up" palette={palette} />
        ) : null}
        <Box flexDirection="column">
          {windowedBlocks.visible.map((block, blockIndex) => {
            if (block.kind === PROJECT_HEADER_KIND) {
              // Raw (untruncated) name — ProjectGroupHeader now owns its own
              // truncation via projectHeaderLayout.ts's
              // buildProjectGroupHeaderLine, which needs the FULL name to
              // decide how much of it fits alongside the rule and count; a
              // pre-truncated name here would double-truncate and could
              // leave the rule with budget it shouldn't have. `blankAbove`/
              // `isEmpty` are read straight off the block (never recomputed)
              // so the rendered row count can't drift from `block.height` —
              // same discipline as `separatorRows` below. `selected` matches
              // only when the header itself is App.tsx's current selection
              // (only possible for an empty group — see
              // ProjectGroupHeader.tsx's "SELECTABLE ONLY WHEN EMPTY" note).
              return (
                <ProjectGroupHeader
                  key={`project-${block.projectId}`}
                  name={block.projectName}
                  visibleCount={block.visibleCount}
                  width={cardAreaWidth}
                  blankAbove={block.blankAbove}
                  isEmpty={block.isEmpty}
                  selected={
                    selectedBlockId?.kind === PROJECT_HEADER_KIND &&
                    selectedBlockId.projectId === block.projectId
                  }
                  palette={palette}
                />
              )
            }
            const workspace = workspaceById.get(block.row.workspaceId)
            // Separator row count comes straight from the BLOCK's own height,
            // not recomputed from the card's position in the visible window —
            // buildBlocks() already shrank the first card of each group by
            // CARD_SEPARATOR_ROWS (it has no previous card to rule off; the
            // project header sits above it with no rule of its own instead),
            // so deriving the rendered row count from `block.height` here is
            // what keeps the rendered rows and the windowing sum mechanically
            // equal — see blocks.ts's `firstCardHeightDelta` doc comment.
            const separatorRows = Math.max(0, block.height - CARD_CONTENT_ROWS)
            return (
              <WorkspaceCard
                key={block.row.workspaceId}
                row={block.row}
                model={workspace?.model ?? null}
                effort={workspace?.effort ?? null}
                providerId={workspace?.providerId ?? null}
                gitBranch={workspace?.gitBranch ?? null}
                selected={
                  selectedBlockId?.kind === 'workspace' &&
                  selectedBlockId.workspaceId === block.row.workspaceId
                }
                separatorRows={separatorRows}
                // A card with a separator row draws a rule in it unless the
                // thing directly above it in the VISIBLE window is a project
                // header (nothing to rule off from) or it's the first visible
                // block overall (its predecessor is scrolled off, so a rule
                // there would hang under the scroll affordance with nothing
                // above it). A card with NO separator row (the first in its
                // group) ignores this — there's no row to draw into.
                showDivider={
                  separatorRows > 0 &&
                  blockIndex > 0 &&
                  windowedBlocks.visible[blockIndex - 1]?.kind !== PROJECT_HEADER_KIND
                }
                width={cardAreaWidth}
                palette={palette}
              />
            )
          })}
        </Box>
        {windowedBlocks.windowed ? (
          <ScrollAffordance count={windowedBlocks.belowCount} direction="down" palette={palette} />
        ) : null}
      </Box>
      {isWide ? (
        // No VRule sibling — the divider is DetailPane's own left border (see
        // that file's header for why a separate rule column could not stay
        // row-aligned with the pane).
        <Box width={DETAIL_PANE_WIDTH} flexShrink={0} marginLeft={VRULE_PAD_X}>
          <DetailPane
            row={selectedRow}
            projectName={selectedProjectName}
            gitBranch={workspaceById.get(selectedRow?.workspaceId ?? '')?.gitBranch ?? null}
            palette={palette}
            width={Math.max(0, DETAIL_PANE_WIDTH - 3)}
            rows={availableRows}
          />
        </Box>
      ) : null}
    </Box>
  )
}

export function App({
  scope,
  initialView,
  initialSelectedWorkspaceId,
  onOpen,
  onQuit,
  onSelectionChange
}: AppProps): React.JSX.Element {
  const frame = useSyncExternalStore(
    frameStore.subscribe,
    frameStore.getSnapshot,
    frameStore.getSnapshot
  )
  // Reconnect/disconnected notice — see connectionStore.ts's header for why
  // this is a separate store from frameStore.
  const connectionNotice = useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getSnapshot,
    connectionStore.getSnapshot
  )
  const { columns, rows } = useWindowSize()
  // Default view is 'all', NOT 'active': isActiveStatus() (layout.ts) only
  // counts attention/in_progress as "active", so an 'active' default hides
  // every awaiting_input/idle workspace on first launch — surprising for a
  // picker whose whole job is showing you what's there. `initialView` lets
  // entry.ts override this with whatever the user last had selected when
  // resuming the picker after a detach (see AppProps' doc comment); the `v`
  // key (handleViewKey below) still cycles active<->all same as always.
  const [view, setView] = useState<Filter>(initialView ?? 'all')
  // Selection is tracked by STABLE ID (workspace id, or — new, for the
  // empty-group fix — a project-header marker), not raw row index — see
  // tui-otui/App.tsx's identical note on the workspace-id half of this: a
  // plain numeric index clamped into bounds across a materially different
  // tree (reconnect, workspaces created/archived/reordered while
  // disconnected) can silently point at a DIFFERENT row than the one
  // actually highlighted. `SelectedBlockId` (blocks.ts) is reused here
  // rather than inventing a parallel type, since this state IS a
  // `SelectedBlockId` in every way that matters — it's threaded straight
  // into `windowBlocks()` below with no translation. `null` means "no
  // explicit selection yet"; resolved against the CURRENT `selectableRows`
  // into `selectedRowIndex`/`selectedEntry` below (derived values, not this
  // raw state — everything else in this component reads THOSE, never this
  // directly). `initialSelectedWorkspaceId` (entry.ts's memory of the last
  // RESOLVED workspace selection from the PREVIOUS picker mount — see
  // AppProps' doc comment: that external contract only ever remembers a
  // workspace, never a header) flows in as the `{ kind: 'workspace', ... }`
  // variant, exactly like the `null` default it replaces when absent — it
  // gets the same stale-id fallback treatment below, no special-casing
  // needed.
  const [selectedWorkspaceIdRaw, setSelectedWorkspaceIdRaw] = useState<SelectedBlockId>(
    initialSelectedWorkspaceId != null
      ? { kind: 'workspace', workspaceId: initialSelectedWorkspaceId }
      : null
  )
  // Deliberately NOT persisted across picker mounts (no initial-value prop,
  // no place in onSelectionChange) — the user just detached from a
  // workspace; on return they expect to see the list, not have a help
  // overlay silently reappear that they may not even remember opening.
  const [helpVisible, setHelpVisible] = useState(false)
  // The new-workspace wizard (`n`) — null means closed. Also NOT persisted
  // across picker mounts, same rationale as `helpVisible`: reopening the
  // picker after a detach should never silently resurrect an in-progress
  // wizard the user has forgotten about. Holds only the inferred project
  // (id/name/cwd) the wizard was opened for; the wizard component itself
  // (NewWorkspaceWizard.tsx) owns every other piece of its own state
  // (selected model, name, mode, submit status) so a re-render of App
  // triggered by an unrelated frame update can never reset wizard progress —
  // this state only flips null<->non-null, it never mutates while the
  // wizard is open.
  const [wizardProject, setWizardProject] = useState<WizardProject | null>(null)

  // The add-project overlay (`p`) — boolean, not nullable-project-id, since
  // unlike the wizard this needs no inferred context (see
  // handleAddProjectKey above). Same not-persisted-across-mounts rationale
  // as `helpVisible`/`wizardProject`: a detach/reattach should never
  // silently resurrect an in-progress add-project prompt. AddProjectPrompt
  // itself owns its own buffer/submit state (mirrors NewWorkspaceWizard
  // owning its own step machine) — this flag only flips true<->false.
  const [addProjectOpen, setAddProjectOpen] = useState(false)

  // The close/archive confirm overlay (`c`/`a`) — null means closed. Same
  // not-persisted-across-mounts rationale as `helpVisible`/`wizardProject`
  // above: a detach/reattach should never silently resurrect an in-progress
  // destructive confirm the user may have forgotten about.
  const [closeArchive, setCloseArchive] = useState<CloseArchiveState | null>(null)

  // TRANSIENT footer notice — originally just the close-confirmation text
  // (see the file header's "THE CRITICAL UX GAP" note: workspace.close
  // destroys the surface/process but the tree frame's own archivedAt-only
  // filter means the row never disappears, so this was the ONLY visible
  // confirmation a close actually happened), now GENERALIZED to any
  // transient one-line message that needs Footer's existing (previously
  // always-null) `notice` prop — `o` (handleSortKey below) reuses it
  // verbatim for a failed project.reorderByActivity call, since a silently-
  // swallowed sort failure is exactly the kind of gap this slot exists to
  // close. Cleared automatically after FOOTER_NOTICE_MS via the ref-tracked
  // timeout below — a NEWER notice (or unmount) always clears whatever timer
  // is currently pending first, so a stale timeout can never clobber a
  // fresher notice that arrived before the old one's 3s elapsed.
  const [footerNotice, setFooterNotice] = useState<string | null>(null)
  const footerNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showFooterNotice(text: string): void {
    if (footerNoticeTimer.current != null) clearTimeout(footerNoticeTimer.current)
    setFooterNotice(text)
    footerNoticeTimer.current = setTimeout(() => {
      footerNoticeTimer.current = null
      setFooterNotice(null)
    }, FOOTER_NOTICE_MS)
  }

  // Unmount-only cleanup — clearing on every render (e.g. via a dep array
  // keyed on footerNotice) would fight showFooterNotice's own clear-then-set
  // above; this effect exists solely so a still-pending timer doesn't fire
  // setState after the whole picker has unmounted (workspace opened, app
  // quitting, etc).
  useEffect(() => {
    return () => {
      if (footerNoticeTimer.current != null) clearTimeout(footerNoticeTimer.current)
    }
  }, [])

  // AGE TICKER — why the ages need one at all.
  //
  // A tree frame carries `lastActivityAt` as a fixed TIMESTAMP; the "2h"
  // you see is formatAge()/formatAgeLong() converting it at RENDER time
  // (see format.ts — both default `nowMs` to Date.now()). So the age is
  // only ever as fresh as the last render.
  //
  // The server deliberately suppresses byte-identical tree frames
  // (commandServer.ts's treeFrameContentKey / scheduleTreeFrameEmit): an
  // idle workspace produces no new frame, so nothing re-renders, so the
  // age sits frozen until some UNRELATED input (j/k, a resize) happens to
  // repaint it. That suppression is correct — an idle picker on a phone
  // over SSH should not be resending unchanged data every few seconds — so
  // the fix belongs HERE, not on the wire: re-render locally on a timer and
  // let the existing formatters recompute against the current clock.
  //
  // See AGE_TICK_MS for why this ticks every second rather than something
  // coarser: the sub-minute range of formatAge() counts real seconds, so a
  // slower timer visibly freezes a just-created workspace.
  //
  // The cost of the extra ticks is a re-render, NOT a re-fetch: nothing
  // here touches the socket, and Ink only writes the rows that actually
  // changed, so a second where no visible label moves is close to free.
  //
  // The state value is deliberately unused-but-incrementing: it exists
  // purely to invalidate the render, since the timestamps themselves never
  // change.
  const [, setAgeTick] = useState(0)
  useEffect(() => {
    const handle = setInterval(() => setAgeTick((n) => n + 1), AGE_TICK_MS)
    handle.unref?.()
    return () => clearInterval(handle)
  }, [])

  const palette = activePalette

  const flattened = useMemo(
    () =>
      frame != null
        ? flattenTree(frame, view, scope)
        : { rows: [] as DisplayRow[], hiddenCount: 0, visibleCount: 0, totalCount: 0 },
    [frame, view, scope]
  )

  // The caret's actual traversal order — see `SelectableRow`'s doc comment
  // for the full history (this used to be a bare `flattened.rows.filter(
  // isWorkspaceRow)`; idle workspaces are still selectable and openable,
  // exactly like every other workspace status — opening one is how you wake
  // it up, and under view:active idle rows are already absent from
  // flattened.rows entirely, per layout.ts's own isActiveStatus/filter
  // behavior). Built in ONE pass over `flattened.rows` so the two row kinds
  // interleave in exactly the order they're rendered.
  const selectableRows = useMemo((): SelectableRow[] => {
    const out: SelectableRow[] = []
    for (const row of flattened.rows) {
      if (row.kind === 'workspace') {
        out.push({ kind: 'workspace', row })
      } else if (row.visibleCount === 0) {
        // Empty project (see blocks.ts's `isEmpty`, derived from this same
        // per-project visibleCount) — its header is the only row it
        // contributes, so it's the only row a caret visiting this project
        // can land on.
        out.push({ kind: PROJECT_HEADER_KIND, row })
      }
    }
    return out
  }, [flattened])

  // Flat workspaceId -> TreeWorkspace lookup, built directly from the raw
  // frame (NOT from DisplayRow, which doesn't carry model/effort/gitBranch)
  // — see the file header's "MODEL/EFFORT/GITBRANCH LOOKUP" note.
  const workspaceById = useMemo(() => {
    const map = new Map<string, TreeWorkspace>()
    if (frame == null) return map
    for (const project of frame.projects) {
      for (const ws of project.workspaces) map.set(ws.id, ws)
    }
    return map
  }, [frame])

  // Derived, not synced-via-effect: re-resolved from `selectedWorkspaceIdRaw`
  // against the CURRENT `selectableRows` every render (see tui-otui/App.tsx's
  // identical `selectedRowIndex` memo for the full rationale). Falls back to
  // index 0 when there's no selection yet OR the previously-selected id is
  // no longer present in this frame — e.g. the project it pointed at gained
  // its first workspace and is no longer in `selectableRows` as a header, or
  // the raw selection is a project-header for a project that isn't in scope
  // at all right now (e.g. `--project` narrowing changed).
  const selectedRowIndex = useMemo(() => {
    if (selectableRows.length === 0) return 0
    if (selectedWorkspaceIdRaw == null) return 0
    const idx = selectableRows.findIndex((r) =>
      sameSelection(selectableRowId(r), selectedWorkspaceIdRaw)
    )
    return idx >= 0 ? idx : 0
  }, [selectableRows, selectedWorkspaceIdRaw])

  const selectedEntry = selectableRows[selectedRowIndex] ?? null
  const selectedRow = selectedEntry?.kind === 'workspace' ? selectedEntry.row : null
  const selectedWorkspaceId = selectedRow?.workspaceId ?? null
  const selectedBlockId = selectedEntry != null ? selectableRowId(selectedEntry) : null

  // Report the RESOLVED view/selection back to entry.ts (whichever picker
  // mount is live right now) so the NEXT `runPickerOnce()` call — after the
  // user opens a workspace, detaches from tmux, and returns — can restore
  // them as `initialView`/`initialSelectedWorkspaceId` instead of resetting
  // to defaults. Keyed on the derived values, not `view`/`selectedWorkspaceIdRaw`
  // directly: `selectedWorkspaceId` has already gone through the stale-id
  // fallback above, so a raw id that no longer resolves to anything never
  // gets echoed back and re-persisted as if it were still valid.
  // `onSelectionChange`'s contract is workspace-id-only (entry.ts / the
  // tmux-detach round trip has no concept of "selection was on a header") —
  // when the caret is resting on an empty project's header this correctly
  // reports `null`, same as "no selection", rather than widening that
  // external contract to a union it doesn't need.
  useEffect(() => {
    onSelectionChange?.(view, selectedWorkspaceId)
  }, [view, selectedWorkspaceId, onSelectionChange])

  // Extended from a bare `.name` lookup into the FULL project object so the
  // new-workspace wizard (opened by `n`, see `wizardProject` state above) can
  // read `cwd` — TreeProject.cwd (types.ts) is exactly the `cwd` arg
  // workspace.create needs, and this is the one place App.tsx already
  // resolves "which project owns the highlighted row". Resolves for BOTH a
  // highlighted workspace card AND a highlighted empty-project header — the
  // whole point of widening `selectableRows` above — by reading `projectId`
  // off whichever kind `selectedEntry` actually is. `selectedProjectName` is
  // derived from this rather than kept as a separate memo, so the two can
  // never disagree about which project is selected.
  const selectedProject = useMemo((): TreeProject | null => {
    if (selectedEntry == null || frame == null) return null
    return frame.projects.find((p) => p.id === selectedEntry.row.projectId) ?? null
  }, [selectedEntry, frame])
  const selectedProjectName = selectedProject?.name ?? null

  function moveSelection(delta: number): void {
    const count = selectableRows.length
    if (count === 0) return
    let next = selectedRowIndex + delta
    if (next < 0) next = 0
    if (next >= count) next = count - 1
    const nextEntry = selectableRows[next]
    // selectableRowId(), not a bare workspaceId-or-null: a header entry must
    // persist as a `project-header` selection, not collapse to `null` (which
    // means "no selection yet" and would make the very next render's
    // selectedRowIndex memo fall back to index 0 instead of staying put).
    setSelectedWorkspaceIdRaw(nextEntry != null ? selectableRowId(nextEntry) : null)
  }

  // Submit workspace.close — on success, close the overlay and arm the
  // Footer notice (see the file header's "THE CRITICAL UX GAP" note); on
  // failure, keep the overlay open and surface the error inline (mirrors the
  // new-workspace wizard's own submitError pattern exactly — the
  // self-action-refusal case, "cannot close/archive the workspace running
  // this command", reads clearly here rather than as a generic failure).
  async function submitClose(state: CloseArchiveState): Promise<void> {
    setCloseArchive((s) => (s == null ? s : { ...s, submitting: true, submitError: null }))
    try {
      await sendCommand('workspace.close', { id: state.workspaceId })
      setCloseArchive(null)
      showFooterNotice(`closed ${state.workspaceName}`)
    } catch (err) {
      setCloseArchive((s) =>
        s == null ? s : { ...s, submitting: false, submitError: errorMessage(err) }
      )
    }
  }

  // Submit workspace.archive — deliberately omits `recursive` (single-
  // workspace archive only; the task brief has no real reason to pass it
  // here). No notice needed on success: the row disappearing from the next
  // /subscribe tree frame (groupActiveWorkspacesByProject filters archived
  // rows out) IS the confirmation, per the task brief.
  async function submitArchive(state: CloseArchiveState): Promise<void> {
    setCloseArchive((s) => (s == null ? s : { ...s, submitting: true, submitError: null }))
    try {
      await sendCommand('workspace.archive', { id: state.workspaceId })
      setCloseArchive(null)
    } catch (err) {
      setCloseArchive((s) =>
        s == null ? s : { ...s, submitting: false, submitError: errorMessage(err) }
      )
    }
  }

  // Key handling while the close/archive confirm is open — mirrors
  // NewWorkspaceWizard.tsx's own useInput dispatch shape (per-step branches,
  // ignore further presses mid-submit). `esc` always cancels back to the
  // picker with no action taken, at ANY stage, per the task brief.
  function handleConfirmInput(
    state: CloseArchiveState,
    input: string,
    key: { escape: boolean; return: boolean }
  ): void {
    if (state.submitting) return // ignore further presses mid-request — no double-submit
    if (key.escape) {
      setCloseArchive(null)
      return
    }
    if (state.mode === 'close') {
      if (key.return) void submitClose(state)
      return
    }
    // 'archive'
    if (state.archiveStage === 'confirm') {
      // `d` is the deliberate, DIFFERENT-key advance to the execute stage —
      // see CloseArchiveConfirm.tsx's file header for why this can't be a
      // same-key double-press. Clears any stale submitError from a previous
      // attempt so re-entering 'confirm' (there's no path back to it once
      // past — esc from 'execute' cancels the whole flow — but defensive
      // regardless) never shows a leftover error.
      if (input === 'd') {
        setCloseArchive({ ...state, archiveStage: 'execute', submitError: null })
      }
      return
    }
    // 'execute'
    if (key.return) void submitArchive(state)
  }

  useInput((input, key) => {
    // The wizard owns its OWN useInput while open (NewWorkspaceWizard.tsx)
    // and this component's body isn't even mounted then (see the render
    // swap below) — but Ink's useInput hooks are all live simultaneously
    // regardless of what's rendered, so this early return is what actually
    // stops j/k/v/q/?/enter from leaking through to the picker's own
    // handlers while the wizard is up, exactly mirroring the `helpVisible`
    // short-circuit immediately below it. The add-project overlay
    // (AddProjectPrompt.tsx) and the close/archive confirm get the exact
    // same treatment: while either is open, every key goes to that
    // overlay's own handler and NOTHING else in this callback may run
    // (including j/k/enter/n/c/a on the row underneath).
    if (wizardProject != null) return
    if (addProjectOpen) return
    if (closeArchive != null) {
      handleConfirmInput(closeArchive, input, key)
      return
    }
    if (helpVisible) {
      setHelpVisible(false)
      return
    }
    if (input === 'q' || key.escape) {
      onQuit()
      return
    }
    if (input === '?') {
      setHelpVisible(true)
      return
    }
    if (input === 'n') {
      handleNewWorkspaceKey(selectedProject, setWizardProject)
      return
    }
    if (input === 'p') {
      handleAddProjectKey(setAddProjectOpen)
      return
    }
    if (input === 'o') {
      handleSortKey(showFooterNotice)
      return
    }
    // `a` (archive) and `c` (close) are BOTH unshifted, and deliberately not
    // a shifted/unshifted pair of the same letter. This UI's primary client
    // is a phone (Termius) where shift is a keyboard mode switch, not a
    // chord: the previous `x`/`X` binding made archive awkward to reach AND
    // put the reversible and the permanently-destructive action one missed
    // shift apart from each other. Two physically distinct letters mean a
    // slip can't silently cross that boundary in either direction. `a`
    // staying unshifted is safe because the protection is the multi-step
    // confirm (a -> d -> enter), never the shift key.
    if (input === 'a') {
      handleCloseArchiveKey('archive', selectedRow, setCloseArchive)
      return
    }
    if (input === 'c') {
      handleCloseArchiveKey('close', selectedRow, setCloseArchive)
      return
    }
    if (key.return) {
      if (selectedWorkspaceId != null) onOpen(selectedWorkspaceId)
      return
    }
    if (key.downArrow || input === 'j') {
      moveSelection(1)
      return
    }
    if (key.upArrow || input === 'k') {
      moveSelection(-1)
      return
    }
    handleViewKey(input, setView)
  })

  const breakpoint = resolveCardBreakpoint(columns)
  const isWide = columns >= WIDE_MIN_COLUMNS

  const headerReserved = headerReservedFor()
  const availableRows = Math.max(0, rows - headerReserved - FOOTER_ROWS)

  // Card width == full available terminal width at every breakpoint —
  // narrowed by the detail pane + vertical rule budget only at wide.
  // One blank column inside each terminal edge, applied ONCE on the root
  // frame below (paddingX) rather than per component — so nothing renders
  // flush against the border and no child can accidentally opt out. Every
  // width computed below is against contentWidth, never the raw terminal
  // width, so a padded child can never overrun the frame it sits in.
  const contentWidth = Math.max(1, columns - FRAME_PAD_X * 2)
  const cardAreaWidth = isWide
    ? Math.max(20, contentWidth - DETAIL_PANE_WIDTH - VRULE_WIDTH)
    : contentWidth

  const blocks = useMemo(
    (): Block[] => buildBlocks(flattened.rows, CARD_HEIGHT, CARD_SEPARATOR_ROWS),
    [flattened]
  )

  // STICKY WINDOW START — see file header's "SOLID -> REACT TRANSLATION"
  // note. `windowStart` is state, not a ref: React's documented "adjust
  // state during render" pattern (calling the setter mid-render when the
  // freshly-computed value differs from the current one) immediately
  // re-renders before paint, with no flash of a stale window and no
  // ref-mutation-during-render lint violation (react-hooks/refs forbids
  // exactly that). windowBlocks() is a pure function of its arguments;
  // calling it again next render with the corrected `windowStart` converges
  // in the same tick.
  const [windowStart, setWindowStart] = useState(0)
  const windowedBlocks = windowBlocks(blocks, selectedBlockId, availableRows, windowStart)
  if (windowedBlocks.start !== windowStart) {
    setWindowStart(windowedBlocks.start)
  }

  const connecting = frame == null && connectionNotice == null
  const empty = frame != null && flattened.totalCount === 0
  const filteredEmpty = frame != null && flattened.totalCount > 0 && flattened.visibleCount === 0

  return (
    // height={rows} + the flexGrow body below are what pin the chrome to the
    // terminal's real edges. Without an explicit height the root Box shrinks
    // to its content, and Ink centres that short block vertically — the whole
    // UI floats in the middle of an otherwise empty terminal with the footer
    // riding directly under the last card instead of sitting at the bottom.
    <Box flexDirection="column" height={rows} paddingX={FRAME_PAD_X}>
      <TitleBar
        scope={scope}
        connected={frame != null && connectionNotice == null}
        disconnected={connectionNotice != null}
        view={view}
        // Hide the hidden-count hint while the wizard or add-project overlay
        // is open: "N hidden (v)" advertises a picker key (`v`) that does
        // nothing right now — both overlays swallow the whole keymap (see
        // useInput's wizardProject/addProjectOpen early-returns above) — so
        // showing it would read as a broken affordance. The connection state
        // itself still matters (both overlays' own sendCommand calls depend
        // on it), so only this one hint is suppressed, not the whole bar.
        hiddenCount={wizardProject != null || addProjectOpen ? 0 : flattened.hiddenCount}
        palette={palette}
        width={contentWidth}
      />
      {wizardProject != null ? (
        <NewWorkspaceWizard
          project={wizardProject}
          width={contentWidth}
          availableRows={availableRows}
          palette={palette}
          onDone={(createdWorkspaceId) => {
            setWizardProject(null)
            // Creating a workspace is intent to WORK in it, so a successful
            // create attaches straight through to its tmux session instead
            // of returning to the list and making the user hunt for the row
            // they just named. `onOpen` is the same path `enter` takes
            // (entry.ts's runTui loop -> hostAndAttach), so this reuses the
            // whole hosting/attach/detach cycle rather than duplicating it.
            //
            // A null id means either a cancel or a create whose response
            // didn't carry one (see createdWorkspaceIdFrom) — both fall back
            // to simply closing the wizard, which is the pre-existing
            // behaviour and always safe.
            if (createdWorkspaceId != null) onOpen(createdWorkspaceId)
          }}
        />
      ) : addProjectOpen ? (
        <AddProjectPrompt
          width={contentWidth}
          palette={palette}
          // Unlike the wizard, there is no created-id to navigate to — the
          // task brief is explicit that a successful add just closes the
          // overlay and lets the new project's row arrive over the existing
          // /subscribe tree-frame connection (frameStore.ts), no manual
          // refetch. The user picks a workspace from it the normal way.
          onDone={() => setAddProjectOpen(false)}
        />
      ) : (
        <PickerScreen
          connectionNotice={connectionNotice}
          connecting={connecting}
          empty={empty}
          filteredEmpty={filteredEmpty}
          windowedBlocks={windowedBlocks}
          cardAreaWidth={cardAreaWidth}
          selectedBlockId={selectedBlockId}
          selectedRow={selectedRow}
          selectedProjectName={selectedProjectName}
          workspaceById={workspaceById}
          isWide={isWide}
          availableRows={availableRows}
          palette={palette}
          helpVisible={helpVisible}
          breakpoint={breakpoint}
          closeArchive={closeArchive}
          footerNotice={footerNotice}
          contentWidth={contentWidth}
        />
      )}
    </Box>
  )
}

interface PickerScreenProps extends PickerBodyProps {
  connectionNotice: string | null
  connecting: boolean
  empty: boolean
  filteredEmpty: boolean
  helpVisible: boolean
  breakpoint: Breakpoint
  closeArchive: CloseArchiveState | null
  footerNotice: string | null
  contentWidth: number
}

/**
 * Resolves what goes where the Footer's keymap normally sits: the help
 * overlay (`?`), the close/archive confirm (`c`/`a`), or the ordinary
 * Footer — carrying its transient notice (close confirmation, or a failed
 * `o` sort) when there is one. Extracted from PickerScreen for the same
 * cognitive-complexity reason everything else in this file gets extracted: a
 * 3-way ternary inline would have pushed PickerScreen itself over budget once
 * the confirm branch joined the pre-existing help<->footer swap.
 */
function FooterArea({
  helpVisible,
  closeArchive,
  footerNotice,
  breakpoint,
  contentWidth,
  palette
}: {
  helpVisible: boolean
  closeArchive: CloseArchiveState | null
  footerNotice: string | null
  breakpoint: Breakpoint
  contentWidth: number
  palette: Palette
}): React.JSX.Element {
  if (helpVisible) {
    return <HelpOverlay breakpoint={breakpoint} palette={palette} />
  }
  if (closeArchive != null) {
    return (
      <CloseArchiveConfirm
        mode={closeArchive.mode}
        archiveStage={closeArchive.archiveStage}
        workspaceName={closeArchive.workspaceName}
        worktreeBranch={closeArchive.worktreeBranch}
        submitting={closeArchive.submitting}
        submitError={closeArchive.submitError}
        width={contentWidth}
        palette={palette}
      />
    )
  }
  return <Footer notice={footerNotice} palette={palette} breakpoint={breakpoint} />
}

/**
 * The picker's own body+footer, extracted from App() itself so its
 * connecting/empty/filtered-empty/normal branching (plus the help<->footer
 * swap) doesn't count against App()'s own cognitive-complexity budget
 * (sonarjs/cognitive-complexity, capped at 20) — the wizard's arrival pushed
 * App() over that cap with this logic still inline. Mirrors PickerBody's own
 * extraction one level up: App() now only decides wizard-vs-picker, this
 * component decides which of the picker's four possible states to show.
 */
function PickerScreen({
  connectionNotice,
  connecting,
  empty,
  filteredEmpty,
  helpVisible,
  breakpoint,
  closeArchive,
  footerNotice,
  contentWidth,
  palette,
  ...pickerBodyProps
}: PickerScreenProps): React.JSX.Element {
  return (
    <>
      {/* flexGrow={1} takes every row the title bar and footer don't, so the
          footer is pushed to the last line at any terminal height. */}
      <Box flexDirection="column" flexGrow={1}>
        {connectionNotice != null ? (
          <Text color={palette.secondary} wrap="truncate-end">
            {connectionNotice}
          </Text>
        ) : connecting ? (
          <Text color={palette.secondary} wrap="truncate-end">
            Connecting to Orpheus…
          </Text>
        ) : empty || filteredEmpty ? (
          // wrap="truncate-end" on every one-line status: without it Ink
          // WRAPS these strings, and on a very narrow terminal the extra rows
          // overflow the frame's fixed height and paint over the footer and
          // the rows beside them (observed at 20 cols as fragments bleeding
          // through). One line that clips is correct here; these are hints,
          // not content.
          <Text color={palette.secondary} wrap="truncate-end">
            {empty ? 'no workspaces' : '(no workspaces — press v to show all)'}
          </Text>
        ) : (
          <PickerBody palette={palette} {...pickerBodyProps} />
        )}
      </Box>
      <FooterArea
        helpVisible={helpVisible}
        closeArchive={closeArchive}
        footerNotice={footerNotice}
        breakpoint={breakpoint}
        contentWidth={contentWidth}
        palette={palette}
      />
    </>
  )
}
