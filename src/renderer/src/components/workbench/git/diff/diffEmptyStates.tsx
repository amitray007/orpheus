// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/diffEmptyStates.tsx
//
// GitTab's Diff sub-tab edge states — extracted verbatim from GitTab.tsx
// (Wave 3 Phase A structural extraction). Prop-driven, no state of their own
// beyond NotARepoState's own render (its `running`/`error` come from
// GitTab's git:init call).
//
// EmptyStateShell — shared centered icon + title + sub-line + optional action
// shell, matching the mockup's `.empty-state` (docs/brainstorms/
// git-tab-mockup/styles.css).
// NotARepoState — State 1: this workspace's cwd isn't a git working tree.
// CleanState — State 2: a real repo with a clean working tree.
// PrDiffEmptyState — Phase 4-pre: PR-diff mode's own empty state (a failed/
// unavailable PR-diff fetch, distinct from CleanState's working-tree copy).
// ---------------------------------------------------------------------------

import type React from 'react'
import { GitBranch, CheckCircle, GitPullRequest } from '@phosphor-icons/react'
import { Button } from '../../../Button'
import { PIERRE_VIEWER_BG } from '../../editor/chromeTheme'

/** Shared empty-state shell — centered icon + title + sub-line + optional
 *  action, matching the mockup's `.empty-state` (docs/brainstorms/
 *  git-tab-mockup/styles.css): centered column, muted 40px icon at 55%
 *  opacity, 13.5px title, 12px muted sub-line capped ~320px wide. Reuses
 *  PIERRE_VIEWER_BG so the edge states sit on the same dark viewer surface
 *  the diff pane itself uses, rather than introducing a third background. */
function EmptyStateShell({
  icon,
  title,
  subtitle,
  children
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-2.5 min-h-0 px-10 text-center"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <div className="text-text-muted opacity-55">{icon}</div>
      <div className="text-[13.5px] font-semibold text-text-primary">{title}</div>
      <div className="text-xs text-text-muted max-w-[320px]">{subtitle}</div>
      {children}
    </div>
  )
}

/** State 1 (mockup) — `!repo`: this workspace's cwd isn't a git working tree
 *  at all. A primary "Git init" button runs `git:init`, then the caller
 *  refetches `git:diff` explicitly (a brand-new `.git` may not be picked up
 *  by the existing watchers immediately — see GitTab's module header).
 *  Inline status text stands in for a toast (the app has no global toast/
 *  notice mechanism to reuse); the button is disabled while the init call is
 *  in flight. */
export function NotARepoState({
  onInit,
  running,
  error
}: {
  onInit: () => void
  running: boolean
  error: string | null
}): React.JSX.Element {
  return (
    <EmptyStateShell
      icon={<GitBranch size={40} weight="regular" />}
      title="Not a git repository"
      subtitle="This workspace's folder isn't tracked by git yet. Initialize a repository here to start tracking changes."
    >
      <Button size="sm" onClick={onInit} loading={running} disabled={running}>
        <GitBranch size={14} />
        Git init
      </Button>
      {error !== null && <span className="text-xs text-red-400 max-w-[320px]">{error}</span>}
    </EmptyStateShell>
  )
}

/** State 2 (mockup) — `repo && files.length === 0`: a real repo with a clean
 *  working tree. `branch` comes from the existing `git:statusChanged` push
 *  GitTab already subscribes to for live-refresh (no new IPC round-trip) —
 *  it's `null` until that first push arrives (or on a branch-less/detached
 *  HEAD repo), in which case this falls back to the branch-less "No changes"
 *  copy rather than blocking the empty state on one. */
export function CleanState({ branch }: { branch: string | null }): React.JSX.Element {
  const title = branch !== null ? `No changes on ${branch}` : 'No changes'
  return (
    <EmptyStateShell
      icon={<CheckCircle size={40} weight="regular" />}
      title={title}
      subtitle="The working tree is clean. Nothing to review yet."
    />
  )
}

/** Phase 4-pre — PR-diff mode's own empty state: `files.length === 0` while
 *  viewing PR diff means every fetch tier came back empty (see
 *  gitDiff.ts::getPrDiff's three-tier doc comment — `gh pr diff`, then the
 *  GitHub files API, then a sync-gated local fallback, in that order). By
 *  the time this renders, the size-cap case (`gh pr diff`'s HTTP 406
 *  "too_large") has almost always already been recovered by the files-API
 *  tier — this only shows when `gh` itself is unusable (missing/unauth/
 *  offline) and the local tree isn't an exact match for the PR's head
 *  commit either. Copy is deliberately non-committal about WHICH of those
 *  happened (no reason is plumbed across IPC) rather than guessing "auth"
 *  specifically, which was misleading in the too-large case this replaces.
 *  Distinct copy from CleanState's "working tree is clean" — that phrasing
 *  would be actively misleading here, since the PR diff has nothing to do
 *  with the working tree at all. */
export function PrDiffEmptyState(): React.JSX.Element {
  return (
    <EmptyStateShell
      icon={<GitPullRequest size={40} weight="regular" />}
      title="No PR diff available"
      subtitle="Couldn't load the PR diff. It may be too large for GitHub, `gh` may not be authenticated, or the base branch isn't available locally. Try switching back to Working tree, or open the PR on GitHub."
    />
  )
}
