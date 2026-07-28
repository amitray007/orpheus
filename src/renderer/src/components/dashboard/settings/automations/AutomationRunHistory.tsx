import type React from 'react'
import { ArrowClockwise, Spinner } from '@phosphor-icons/react'
import type {
  AutomationManualRetryReason,
  AutomationRunStatus,
  AutomationRunWithEligibility
} from '@shared/types'

const STATUS_STYLES: Record<AutomationRunStatus, string> = {
  queued: 'text-blue-400 border-blue-400/20 bg-blue-400/5',
  running: 'text-blue-400 border-blue-400/20 bg-blue-400/5',
  retry_wait: 'text-amber-400 border-amber-400/20 bg-amber-400/5',
  succeeded: 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5',
  failed: 'text-red-400 border-red-400/20 bg-red-400/5',
  timed_out: 'text-red-400 border-red-400/20 bg-red-400/5',
  interrupted: 'text-amber-400 border-amber-400/20 bg-amber-400/5',
  cancelled: 'text-text-muted border-border-default bg-surface-overlay',
  budget_exhausted: 'text-amber-400 border-amber-400/20 bg-amber-400/5'
}

const RETRY_REASON: Record<AutomationManualRetryReason, string> = {
  eligible: 'Retry this failed occurrence',
  definition_not_found: 'The automation no longer exists',
  definition_disabled: 'Enable the automation before retrying',
  idempotency_unsupported: 'This operation does not support safe manual retry',
  run_not_terminal_failure: 'Only terminal failed runs can be retried',
  not_latest_generation: 'A newer retry generation already exists',
  definition_not_current: 'The definition or its scope is no longer current'
}

function formatTime(value: number | null): string {
  return value == null ? '—' : new Date(value).toLocaleString()
}

function statusLabel(status: AutomationRunStatus): string {
  return status.replaceAll('_', ' ')
}

export function AutomationRunHistory({
  runs,
  loading,
  error,
  pendingRetryId,
  onRefresh,
  onRetry
}: {
  runs: readonly AutomationRunWithEligibility[]
  loading: boolean
  error: string | null
  pendingRetryId: string | null
  onRefresh: () => void
  onRetry: (run: AutomationRunWithEligibility) => void
}): React.JSX.Element {
  return (
    <div id="setting-automation-run-history" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Run history
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            Redacted status summaries refresh every four seconds while selected.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh automation run history"
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border-default text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-[color,background-color,transform,opacity] duration-150 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowClockwise size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-400"
        >
          Couldn’t refresh run history: {error}
        </div>
      )}

      {loading && runs.length === 0 ? (
        <div
          role="status"
          className="flex items-center justify-center gap-2 rounded-lg border border-border-default bg-surface-raised py-10 text-xs text-text-muted"
        >
          <Spinner size={13} className="animate-spin" aria-hidden="true" />
          Loading run history…
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-border-default bg-surface-raised px-4 py-10 text-center">
          <p className="text-sm text-text-secondary">No runs recorded</p>
          <p className="text-xs text-text-muted mt-1">
            Runs appear here after an enabled trigger fires.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border-default bg-surface-raised divide-y divide-border-default/40 overflow-hidden">
          {runs.map((run) => {
            const retrying = pendingRetryId === run.id
            const retryReasonId = `automation-retry-reason-${run.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
            return (
              <div key={run.id} className="px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={[
                          'text-[10px] uppercase tracking-wider rounded border px-1.5 py-0.5',
                          STATUS_STYLES[run.status]
                        ].join(' ')}
                      >
                        {statusLabel(run.status)}
                      </span>
                      <span className="text-[11px] text-text-muted">
                        Attempt {run.attempt}
                        {run.retryGeneration > 0 ? ` · Retry ${run.retryGeneration}` : ''}
                      </span>
                    </div>
                    <p className="text-xs text-text-secondary mt-1.5">
                      {run.trigger.kind === 'event' ? 'Event' : 'Schedule'} ·{' '}
                      {formatTime(run.trigger.occurredAt)}
                    </p>
                    <p className="text-[11px] text-text-muted mt-1">
                      {run.resultCode ?? 'No result code'}
                      {run.hasResult ? ' · result recorded' : ''}
                      {run.hasError ? ' · error recorded' : ''}
                    </p>
                    {run.nextAttemptAt != null && (
                      <p className="text-[11px] text-amber-400 mt-1">
                        Next attempt: {formatTime(run.nextAttemptAt)}
                      </p>
                    )}
                  </div>
                  <div className="flex max-w-40 flex-col items-end gap-1 flex-shrink-0">
                    <button
                      type="button"
                      disabled={!run.manualRetry.eligible || retrying}
                      aria-describedby={!run.manualRetry.eligible ? retryReasonId : undefined}
                      onClick={() => onRetry(run)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-[color,background-color,transform,opacity] duration-150 active:scale-[0.97] disabled:opacity-35 disabled:cursor-not-allowed"
                    >
                      {retrying ? (
                        <Spinner size={11} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <ArrowClockwise size={11} aria-hidden="true" />
                      )}
                      Retry
                    </button>
                    {!run.manualRetry.eligible && (
                      <p
                        id={retryReasonId}
                        className="text-right text-[10px] leading-snug text-text-muted"
                      >
                        {RETRY_REASON[run.manualRetry.reason]}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
