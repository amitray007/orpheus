import type React from 'react'
import {
  GitBranch,
  Files,
  GitPullRequest,
  GitMerge,
  Check,
  X,
  CircleNotch
} from '@phosphor-icons/react'
import type { DetailsCardProps } from '@shared/types'
import { openPrUrl } from '../../lib/overlayClient'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// DetailsCard — workspace title bar "Details" popover. Section order: PR,
// Model & Usage (model/context/cost rows with loading '…' / empty '—' muted
// placeholders), Repository (git + cwd). Width target ~252px.
// ---------------------------------------------------------------------------

function SectionHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="text-[10px] font-medium uppercase tracking-wide text-text-muted px-2.5 pt-2.5 pb-1.5">
      {children}
    </p>
  )
}

function PrRow({ pr }: { pr: NonNullable<DetailsCardProps['pr']> }): React.JSX.Element {
  const stateColor =
    pr.state === 'merged'
      ? 'text-gh-merged'
      : pr.state === 'closed'
        ? 'text-gh-closed'
        : pr.state === 'draft'
          ? 'text-gh-draft'
          : 'text-gh-open'
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (pr.url) openPrUrl(pr.url)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded bg-surface-overlay/50 border border-border-default/40 hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
    >
      <span className={`inline-flex items-center ${stateColor}`}>
        {pr.state === 'merged' ? (
          <GitMerge size={12} weight="fill" />
        ) : (
          <GitPullRequest size={12} weight={pr.state === 'draft' ? 'regular' : 'fill'} />
        )}
      </span>
      <span className={stateColor}>#{pr.number}</span>
      {pr.check === 'ok' && <Check size={11} weight="bold" className="text-gh-open" />}
      {pr.check === 'fail' && <X size={11} weight="bold" className="text-gh-closed" />}
      {pr.check === 'pending' && (
        <CircleNotch size={11} weight="bold" className="text-gh-draft animate-spin" />
      )}
    </button>
  )
}

function LabelRow({
  label,
  value,
  loading,
  muted
}: {
  label: string
  value: string
  loading?: boolean
  muted?: boolean
}): React.JSX.Element {
  const display = loading ? '…' : value.length > 0 ? value : '—'
  const isMuted = loading || value.length === 0 || muted
  return (
    <div className="flex items-baseline gap-2 text-xs px-2.5 py-[3px]">
      <span className="w-14 flex-shrink-0 text-text-muted">{label}</span>
      <span
        className={isMuted ? 'text-text-muted italic truncate' : 'text-text-secondary truncate'}
      >
        {display}
      </span>
    </div>
  )
}

export function DetailsCard({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as DetailsCardProps
  const { pr, model, contextText, contextLoading, cost, costLoading, git, cwd, isDirty } = data

  const hasRepoSection = !!git || (cwd && cwd.length > 0)

  return (
    <div className="w-max max-w-[252px] rounded-lg border border-border-default bg-surface-raised shadow-lg font-[family-name:var(--font-sans)] overflow-hidden">
      {isDirty && (
        <div className="mx-2.5 mt-2.5 rounded-md border border-amber-400/30 bg-amber-400/[0.04] px-2.5 py-2 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
          <span className="text-xs text-amber-200/90 flex-shrink-0">Settings changed</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              emit('restart')
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="ml-auto text-xs font-medium text-amber-300 hover:text-amber-100 underline underline-offset-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40 rounded"
          >
            Restart to apply
          </button>
        </div>
      )}
      {pr && (
        <>
          <SectionHeader>Pull Request</SectionHeader>
          <div className="px-2.5 pb-2">
            <PrRow pr={pr} />
          </div>
          <div className="h-px bg-border-default/60" />
        </>
      )}

      <SectionHeader>Model &amp; Usage</SectionHeader>
      <div className="pb-2">
        <LabelRow label="Model" value={model ?? ''} muted={!model} />
        <LabelRow label="Context" value={contextText ?? ''} loading={contextLoading} />
        <LabelRow label="Cost" value={cost ?? ''} loading={costLoading} />
      </div>

      {hasRepoSection && (
        <>
          <div className="h-px bg-border-default/60" />
          <SectionHeader>Repository</SectionHeader>
          <div className="px-2.5 pb-2.5 flex flex-col gap-1.5">
            {git && (
              <>
                <div className="flex items-center gap-1.5 text-xs">
                  <GitBranch size={11} className="text-text-muted flex-shrink-0" />
                  <span
                    className={
                      git.detached
                        ? 'italic text-text-muted truncate'
                        : 'text-text-secondary truncate'
                    }
                  >
                    {git.branch || '(unknown)'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <Files size={11} className="text-text-muted flex-shrink-0" />
                  <span className="text-text-secondary truncate flex-1">{git.summary}</span>
                  {(git.insertions > 0 || git.deletions > 0) && (
                    <span className="font-mono text-[10px] flex-shrink-0">
                      {git.insertions > 0 && (
                        <span className="text-emerald-400">+{git.insertions}</span>
                      )}
                      {git.insertions > 0 && git.deletions > 0 && ' '}
                      {git.deletions > 0 && <span className="text-red-400">−{git.deletions}</span>}
                    </span>
                  )}
                </div>
              </>
            )}
            {cwd && (
              <p className="text-[10px] font-mono text-text-muted leading-relaxed break-all whitespace-pre-line">
                {cwd}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
