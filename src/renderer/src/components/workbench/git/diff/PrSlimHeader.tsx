// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/PrSlimHeader.tsx
//
// GitTab's full-PR slim header row — extracted verbatim from GitTab.tsx
// (Wave 3 Phase A structural extraction; see the module header's Phase 3a /
// PR-header-polish notes for the full history this carries forward).
//
// WorktreeChip — "worktree · <branch>" pill; renders null for a main-checkout
// workspace (see its own doc comment for the "stray local pill" fix this
// codifies).
// BranchCopyButton — copy-to-clipboard for the PR header's branch chip.
// PrSlimHeader — the full-width wrapping row: status badge, clickable title,
// #id, branch chip (+copy), worktree chip. Rendered by GitTab only while a
// PR is detected for the current branch.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type React from 'react'
import { GitMerge, GitPullRequest, X, Copy, Check } from '@phosphor-icons/react'
import type { GhPullRequest, GhPullRequestState } from '@shared/types'
import { openPrUrl } from '../../../../lib/overlayClient'

// --- Worktree chip ------------------------------------------------------------

/** "worktree · <branch>" — the app already tracks worktreeParentCwd/
 *  worktreeBranch per workspace (see WorkspaceTitleBar's own worktree chip),
 *  so this is pure presentation over props passed down from WorkspaceView, no
 *  new IPC needed.
 *
 *  BUG FIX — the stray "local" pill: this component used to render a literal
 *  "local" pill for the (extremely common) main-checkout case, sitting in the
 *  sub-tab-strip row right next to [Diff|Commits|Details|Checks] — from a QA
 *  glance it read as a bogus extra segment glued onto the tab strip, not as a
 *  deliberate "this is not a worktree" indicator. Root cause: a
 *  worktree-vs-main-checkout distinction doesn't need an always-visible
 *  "local" pill to make its point — it only needs to say something when
 *  there IS something notable to say (i.e. this workspace IS an isolated
 *  worktree). So this now renders `null` entirely for the non-worktree case;
 *  only a genuine worktree gets a chip, which GitTab places in the PR slim
 *  header row (see PrSlimHeader) rather than in the sub-tab-strip row this
 *  used to occupy. */
export function WorktreeChip({
  worktreeParentCwd,
  worktreeBranch
}: {
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}): React.JSX.Element | null {
  if (worktreeParentCwd === null) return null
  return (
    <span
      title={`Worktree branch: ${worktreeBranch ?? 'unknown'}\nParent repo: ${worktreeParentCwd}`}
      className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-text-muted bg-surface-overlay/60 border border-border-default/60 select-none whitespace-nowrap"
    >
      {`worktree · ${worktreeBranch ?? '?'}`}
    </span>
  )
}

// --- Branch copy button --------------------------------------------------------

/** Copy-to-clipboard button for the PR header's branch chip — mirrors
 *  git/CommitsTab.tsx's `CommitShaCopyButton` pattern 1:1 (copy via
 *  `navigator.clipboard`, flip to a Check icon for ~1.2s, reset on unmount/
 *  re-click via the same cleanup-timer shape) rather than re-deriving a
 *  second copy-button implementation for a branch name instead of a SHA. */
function BranchCopyButton({ branch }: { branch: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(id)
  }, [copied])

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(branch)
      setCopied(true)
    } catch (err) {
      console.error('[GitTab] clipboard copy failed:', err)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      aria-label={copied ? 'Copied branch name' : `Copy branch name ${branch}`}
      title={copied ? 'Copied' : 'Copy branch name'}
      className="p-0.5 rounded text-text-muted hover:text-text-primary transition-colors duration-150 cursor-pointer"
    >
      {copied ? (
        <Check size={10} weight="bold" className="text-emerald-400" />
      ) : (
        <Copy size={10} weight="bold" />
      )}
    </button>
  )
}

// --- PR slim header (Phase 3a) ------------------------------------------------

// Badge color/label/icon per PR state — same vocabulary PrChip.tsx already
// established (github/PrChip.tsx's STATE_COLOR/STATE_LABEL) for the sidebar/
// kanban/title-bar chip. Duplicated here as small literals rather than
// imported: PrChip's own component renders its OWN compact pill shape
// (rounded-full pixel badge, tokenized bg colors) that doesn't match the
// mockup's `.pr-badge` (solid color chip, white text, pill icon+label) this
// header specifically asks for — see docs/brainstorms/git-tab-mockup's
// `renderPrHeader`. Same "duplicated small literal, independently editable"
// rationale the module already applies to TREE_THEME/IMAGE_EXTENSIONS.
const PR_BADGE_BG: Record<GhPullRequestState, string> = {
  open: 'bg-gh-open',
  draft: 'bg-gh-draft',
  merged: 'bg-gh-merged',
  closed: 'bg-gh-closed'
}

const PR_BADGE_LABEL: Record<GhPullRequestState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

function PrBadgeIcon({ state }: { state: GhPullRequestState }): React.JSX.Element {
  if (state === 'merged') return <GitMerge size={11} weight="fill" />
  if (state === 'closed') return <X size={11} weight="bold" />
  return <GitPullRequest size={11} weight={state === 'draft' ? 'regular' : 'fill'} />
}

/** Full-PR slim header (requirements doc's "Full-PR experience" → slim
 *  header; mockup's `.pr-header--slim`/`renderPrHeader`): status badge, a
 *  clickable title (→ `openPrUrl`, no separate link button per the doc),
 *  `#<number>`, and the current branch. Rendered ABOVE the existing tab
 *  header row, only while a PR is detected for this branch — `pr === null`
 *  (no PR / no `gh` / no remote / detached HEAD) means this never mounts and
 *  the rest of the tab is visually unchanged from Phase 1/2.
 *
 *  Base branch: `GhPullRequest` (shared/types.ts) has no base-ref field
 *  today, so — per the doc's "keep 3a simple: branch shown; base
 *  best-effort" — this only shows the head branch; a future pass can thread
 *  `baseRefName` through `getPrForBranch` and add the mockup's
 *  `branch → base` arrow here without changing this component's shape.
 *
 *  Layout: ONE `flex flex-wrap` row — badge, title, #id, branch chip (+copy),
 *  worktree chip — that fills the header's width and wraps to a second line
 *  when it doesn't fit, instead of truncating or overflowing. `gap-x`/`gap-y`
 *  give both the inline spacing and a sane row-gap once it wraps. The title
 *  is `min-w-0` + no `truncate`/`whitespace-nowrap` so long titles can break
 *  across lines like any other wrapped inline content, and it keeps its
 *  `openPrUrl` click/hover-underline behavior.
 *
 *  Worktree chip: `null` for a main checkout, so nothing renders for the
 *  common case; a genuine worktree gets its chip placed after the branch
 *  chip. */
export function PrSlimHeader({
  pr,
  branch,
  worktreeParentCwd,
  worktreeBranch
}: {
  pr: GhPullRequest
  branch: string | null
  worktreeParentCwd: string | null
  worktreeBranch: string | null
}): React.JSX.Element {
  return (
    <div className="flex-shrink-0 px-3.5 py-2.5 border-b border-border-default bg-surface-raised">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span
          className={`flex-shrink-0 inline-flex items-center gap-1 text-[10.5px] font-bold px-1.5 py-0.5 rounded-full text-white tracking-wide ${PR_BADGE_BG[pr.state]}`}
        >
          <PrBadgeIcon state={pr.state} />
          {PR_BADGE_LABEL[pr.state]}
        </span>
        <button
          type="button"
          onClick={() => openPrUrl(pr.url)}
          title="Open in browser"
          className="min-w-0 text-left text-[15px] font-semibold text-text-primary cursor-pointer hover:underline"
        >
          {pr.title}
        </button>
        <span className="flex-shrink-0 text-[11.5px] text-text-muted">#{pr.number}</span>
        {branch !== null && (
          <span className="flex-shrink-0 inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0 rounded bg-surface-overlay border border-border-default text-text-secondary">
            {branch}
            <BranchCopyButton branch={branch} />
          </span>
        )}
        <WorktreeChip worktreeParentCwd={worktreeParentCwd} worktreeBranch={worktreeBranch} />
      </div>
    </div>
  )
}
