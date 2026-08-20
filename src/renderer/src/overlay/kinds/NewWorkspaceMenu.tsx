import type React from 'react'
import { useEffect, useRef } from 'react'
import { GitBranch, House, SpinnerGap } from '@phosphor-icons/react'
import type { NewWorkspaceMenuProps } from '@shared/types'
import type { OverlayKindProps } from '../registry'
import { ProviderIcon } from '../../components/ProviderIcon'
import { isHarnessRowDisabled } from '../../lib/newWorkspaceMenuLogic'

// ---------------------------------------------------------------------------
// NewWorkspaceMenu (overlay kind) — dumb render + emit, rendered in the
// native overlay layer (src/main/overlayLayer.ts) so the "+ new workspace"
// popover paints OVER the terminal instead of being clipped inside the
// sidebar. Props down (a pure serializable snapshot the call site recomputes
// on every state change), events up (emit() — the call site owns every
// window.api.* call and turns each event into a hook call + an
// updateNewWorkspaceMenu push). Mirrors WorkspaceSettingsCard.tsx's contract.
//
// HARNESS-SELECTOR REBUILD (support-multi-harness — replaces the old
// provider/model creation flow entirely; read this before touching anything
// below): the popover used to be a two-level provider -> model picker (a
// flyout submenu, a committed top-line "selected model" summary, and a
// SEPARATE click on that summary/Enter to actually create — a
// select-then-confirm flow). That whole model list is GONE. Per the
// approved redesign: "Instead of showing the models and the selector,
// replace it with the harness itself... As soon as I click on any harness,
// it should open the terminal directly." So:
//
//   - HarnessRow is now the PRIMARY control, not a hidden extra shown only
//     past a length-> 1 gate. It is the popover's only selection UI, and
//     clicking a harness ROW BOTH selects it AND creates immediately —
//     one click, no separate confirm/create step. This is a deliberate
//     departure from every OTHER selector in this popover (IsolationRow is
//     still a pure two-way TOGGLE that never creates by itself) — harness
//     rows are the one exception, by explicit product decision, because
//     there is no longer any other action left to "confirm" with.
//   - The launched workspace's actual MODEL comes from whatever that
//     harness's own settings resolve to at launch time
//     (composeClaudeLaunch layering global -> project -> workspace) — this
//     popover no longer picks a model at creation time at all.
//   - Local/Worktree stays EXACTLY as it was: same position, same look, same
//     two-way-toggle behavior, same inline branch field when Worktree is
//     selected. Clicking a harness while Worktree is selected AND the
//     branch field has valid (non-blank) text creates the worktree
//     workspace using that text; an empty branch leaves every harness row
//     disabled (see decideHarnessCreateAction in newWorkspaceMenuLogic.ts —
//     the pure decision half of this, asserted by
//     scripts/verify-new-workspace-menu.ts).
//
// Everything the old flow needed ONLY for its provider/model flyout —
// ProviderRow, TopLine, SubmenuPanel, the phantom-hover-from-resize guard
// (useGenuineHoverGate/reduceRowHover), the left/right flip
// (computeSubmenuSide), labelFor, hoverProvider/pickProvider/pickModel/
// enterSubmenu/leaveSubmenu/backToProviders — is deleted from THIS file.
// None of that machinery was actually about the harness picker; it existed
// purely to support a flyout submenu that no longer exists here. It still
// lives on in newWorkspaceMenuLogic.ts and useGenuineHoverGate.ts because
// ChipGroupedDropdown.tsx (the footer Model chip's OWN provider -> model
// flyout, for picking a model on an ALREADY-RUNNING workspace) still needs
// every one of those fixes for its own, still-present submenu — see that
// file's header comment.
// ---------------------------------------------------------------------------

/** Local/Worktree isolation-mode selector row — a two-way TOGGLE only
 *  (never creates). Unchanged by the harness-selector rebuild: same
 *  position, same look, same behavior as before. */
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
    <div className="flex items-center gap-1.5 px-2 pt-1.5">
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

/** Harness picker row (support-multi-harness) — the popover's PRIMARY and
 *  now only selection control. Unlike every other row in this popover
 *  (IsolationRow is a pure toggle), clicking a harness row both selects it
 *  AND creates immediately — see this file's header comment for why. Always
 *  rendered (the old `harnesses.length <= 1` gate is gone — with a real
 *  second harness (Codex) now registered, hiding this until "more than one"
 *  would still hide it exactly when it's needed most: a single-harness
 *  build still shows its one row so the control's presence and behavior
 *  never depends on how many harnesses happen to be registered). */
function HarnessRow({
  harnesses,
  disabled,
  creating,
  onPick
}: {
  harnesses: NewWorkspaceMenuProps['harnesses']
  /** True when worktree isolation is selected but the branch field is
   *  blank — matches decideHarnessCreateAction's 'disabled' case. Every
   *  row is disabled together rather than letting a click silently no-op. */
  disabled: boolean
  /** True while a worktree create is in flight — rows are disabled to
   *  avoid a double-create from a second click. */
  creating: boolean
  onPick: (harnessId: string) => void
}): React.JSX.Element {
  return (
    <div role="group" aria-label="Harness" className="flex flex-col gap-1 px-2 pt-1.5 pb-1">
      {harnesses.map((harness) => (
        <button
          key={harness.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPick(harness.id)
          }}
          disabled={disabled || creating}
          title={`Start a ${harness.label} workspace`}
          className={[
            'w-full flex items-center gap-2 text-xs px-2.5 py-2 rounded-md border font-medium transition-colors duration-100 cursor-pointer text-left',
            'border-border-default text-text-primary hover:bg-surface-raised hover:border-accent/30',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            disabled || creating ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''
          ].join(' ')}
        >
          <ProviderIcon providerId={harness.icon ?? harness.id} size={14} />
          <span className="truncate">{harness.label}</span>
        </button>
      ))}
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

export function NewWorkspaceMenu({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as NewWorkspaceMenuProps
  const {
    loading,
    isolation,
    modes,
    branchValue,
    branchExists,
    branchCreating,
    branchError,
    harnesses
  } = data

  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  // Every harness row shares the same disabled condition — isHarnessRowDisabled
  // is the exact pure predicate decideHarnessCreateAction's 'disabled'
  // branch is built on (newWorkspaceMenuLogic.ts), so this can never drift
  // from what a click would actually decide.
  const harnessRowsDisabled = isHarnessRowDisabled(isolation, branchValue)

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      emit('cancel')
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          emit('cancel')
        }
      }}
      className="w-64 rounded-md border border-border-default bg-surface-overlay shadow-lg py-1.5 outline-none font-[family-name:var(--font-sans)]"
    >
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted">
          <SpinnerGap size={12} className="animate-spin flex-shrink-0" />
          Loading…
        </div>
      ) : (
        <>
          {/* Harness selector FIRST — a vertical stack of full-width rows,
              one per registered harness (logo + label), and the popover's
              ONLY create action: one click both picks the harness AND
              creates. It leads because it is the actual decision; the rows
              below only qualify HOW that workspace is made. */}
          <HarnessRow
            harnesses={harnesses}
            disabled={harnessRowsDisabled}
            creating={branchCreating}
            onPick={(harnessId) => emit('pickHarness', { harnessId })}
          />

          {/* Local / Worktree — isolation SELECTOR only, below the harness
              list. Neither button creates; each just toggles `isolation`,
              which the harness rows above then read when one is clicked. */}
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
}
