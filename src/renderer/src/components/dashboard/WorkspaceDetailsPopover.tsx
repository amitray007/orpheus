import { useEffect, useState } from 'react'
import type React from 'react'
import { GitBranch, Files } from '@phosphor-icons/react'
import type { GhPullRequest, WorkspaceRecord, SessionCost, SessionUsage } from '@shared/types'
import { PrChip } from '../github/PrChip'
import { useGitStatus } from '../../lib/gitStore'
import {
  modelLabel,
  shortTokens,
  contextBudgetCache,
  type ContextBudgetInfo
} from './WorkspaceTitleBar'

// ── Section header ────────────────────────────────────────────────────────
function SectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="px-3 pt-2.5 pb-1">
      <span className="text-[10px] uppercase tracking-wide text-text-muted font-medium">
        {label}
      </span>
    </div>
  )
}

// ── Labeled row ───────────────────────────────────────────────────────────
function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 px-3 py-0.5">
      <span className="w-16 flex-shrink-0 text-text-muted text-[11px] leading-4 pt-px">
        {label}
      </span>
      <div className="flex-1 min-w-0 text-[11px] leading-4 text-text-secondary">{children}</div>
    </div>
  )
}

interface WorkspaceDetailsPopoverProps {
  workspace: WorkspaceRecord
  pr: GhPullRequest | null
  onClose: () => void
  inDrawer?: boolean
}

export function WorkspaceDetailsPopover({
  workspace,
  pr,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- prop reserved for callers that need programmatic close; floating-ui dismiss handles close internally
  onClose: _onClose,
  inDrawer = false
}: WorkspaceDetailsPopoverProps): React.JSX.Element {
  // ── Model & context ──────────────────────────────────────────────────────
  const cacheKey = `${workspace.id}:${workspace.claudeSessionId ?? ''}`
  const [modelCtx, setModelCtx] = useState<ContextBudgetInfo | null>(
    contextBudgetCache.get(cacheKey) ?? null
  )

  useEffect(() => {
    let cancelled = false
    // Prefer cached data; re-fetch to stay fresh
    const stale = contextBudgetCache.get(cacheKey)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: seed popover from cache on mount before async result arrives
    if (stale) setModelCtx(stale)

    window.api.sessions
      .getContextBudget(workspace.id)
      .then((result) => {
        if (!cancelled && result) setModelCtx(result)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [workspace.id, workspace.claudeSessionId, cacheKey])

  // ── Session usage (used context tokens) ──────────────────────────────────
  const [usage, setUsage] = useState<SessionUsage | null>(null)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset usage state on workspace/session change before async fetch completes
    setUsage(null)
    window.api.actions
      .invoke(
        { id: 'session.getUsage', params: {}, workspaceId: workspace.id },
        'workspace-context'
      )
      .then((result) => {
        if (!cancelled && result.ok && result.value != null) {
          setUsage(result.value as SessionUsage)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [workspace.id, workspace.claudeSessionId])

  // ── Cost ─────────────────────────────────────────────────────────────────
  const [cost, setCost] = useState<SessionCost | null>(null)
  const [costLoading, setCostLoading] = useState(true)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset loading/cost state on workspace change before async fetch completes
    setCostLoading(true)
    setCost(null)
    window.api.actions
      .invoke({ id: 'session.getCost', params: {}, workspaceId: workspace.id }, 'workspace-details')
      .then((result) => {
        if (result.ok && result.value != null) {
          setCost(result.value as SessionCost)
        }
      })
      .catch(() => {})
      .finally(() => setCostLoading(false))
  }, [workspace.id, workspace.claudeSessionId])

  // ── Git status ────────────────────────────────────────────────────────────
  const gitStatus = useGitStatus(workspace.id)

  const fileSummaryParts: string[] = []
  if (gitStatus) {
    if (gitStatus.newFiles > 0) fileSummaryParts.push(`${gitStatus.newFiles} new`)
    if (gitStatus.modifiedFiles > 0) fileSummaryParts.push(`${gitStatus.modifiedFiles} modified`)
    if (gitStatus.deletedFiles > 0) fileSummaryParts.push(`${gitStatus.deletedFiles} deleted`)
  }
  const fileSummary = fileSummaryParts.join(' · ')
  const hasLineChanges = gitStatus !== null && (gitStatus.insertions > 0 || gitStatus.deletions > 0)

  const hasPr = pr !== null
  const hasModelCtx = modelCtx !== null

  return (
    <div
      className={
        inDrawer
          ? 'w-full text-xs pointer-events-auto pb-2'
          : 'w-72 bg-surface-overlay border border-white/10 rounded-lg shadow-lg text-xs z-50 pointer-events-auto overflow-hidden pb-2'
      }
    >
      {/* ── PR section ── */}
      {hasPr && (
        <>
          <SectionHeader label="Pull Request" />
          <div className="px-3 pb-1.5">
            <PrChip pr={pr} variant="chip" clickable={true} />
          </div>
          <div className="border-t border-white/10 mt-1" />
        </>
      )}

      {/* ── Model & Usage section ── */}
      <SectionHeader label="Model & Usage" />
      <div className="space-y-0.5 pb-1.5">
        {hasModelCtx ? (
          <>
            <Row label="Model">{modelLabel(modelCtx.modelId)}</Row>
            <Row label="Context">
              {usage
                ? `${shortTokens(usage.lastTurnContextTokens)} / ${shortTokens(modelCtx.contextBudget)} · ${Math.round(usage.usedPct)}%`
                : shortTokens(modelCtx.contextBudget)}
            </Row>
          </>
        ) : (
          <Row label="Model">
            <span className="text-text-muted italic">no session yet</span>
          </Row>
        )}
        <Row label="Cost">
          {costLoading ? (
            <span className="text-text-muted">…</span>
          ) : cost !== null ? (
            <span>${cost.usd.toFixed(2)}</span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </Row>
      </div>

      {/* ── Repository section ── */}
      <div className="border-t border-white/10" />
      <SectionHeader label="Repository" />
      <div className="space-y-0.5 pb-1">
        {gitStatus !== null && (
          <>
            <Row label="Branch">
              <span className="flex items-center gap-1">
                <GitBranch size={11} className="text-text-muted flex-shrink-0" />
                <span className={gitStatus.branch === null ? 'italic text-text-muted' : ''}>
                  {gitStatus.branch ?? 'detached'}
                </span>
              </span>
            </Row>
            <Row label="Changes">
              <span className="flex items-center gap-1.5 flex-wrap">
                <Files size={11} className="text-text-muted flex-shrink-0" />
                <span>{fileSummary || 'No changes'}</span>
                {hasLineChanges && (
                  <span className="flex items-center gap-1 font-mono text-[10px]">
                    {gitStatus.insertions > 0 && (
                      <span className="text-emerald-400">+{gitStatus.insertions}</span>
                    )}
                    {gitStatus.deletions > 0 && (
                      <span className="text-red-400">−{gitStatus.deletions}</span>
                    )}
                  </span>
                )}
              </span>
            </Row>
          </>
        )}
        <Row label="Path">
          <span
            className="font-mono text-[10px] text-text-muted break-all leading-relaxed"
            title={workspace.cwd}
          >
            {workspace.cwd}
          </span>
        </Row>
      </div>
    </div>
  )
}
