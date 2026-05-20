import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState, FooterActionDescriptor } from '@shared/types'
import { SettingRow, Toggle } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { ConfirmModal } from '../../ConfirmModal'

// ---------------------------------------------------------------------------
// OrpheusFooterSection — Workspace Footer settings stub (phase 3b)
// Phase 4 will add a full action editor. This stub shows:
//   1. Show/hide toggle
//   2. Read-only list of current merged actions
//   3. "Reset to defaults" button
// ---------------------------------------------------------------------------

export function OrpheusFooterSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [actions, setActions] = useState<FooterActionDescriptor[]>([])
  const [actionsLoading, setActionsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.uiState
      .get()
      .then((s) => {
        if (!cancelled) setUiState(s)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    // Load global footer actions for the read-only list
    window.api.footerActions
      .listAtScope('global')
      .then((rows) => {
        if (!cancelled) {
          setActions(rows)
          setActionsLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setActionsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function toggleFooter(v: boolean): void {
    if (!uiState) return
    setUiState({ ...uiState, showWorkspaceFooter: v })
    window.api.uiState.update({ showWorkspaceFooter: v }).catch((err) => {
      console.error('[settings] showWorkspaceFooter update failed', err)
      window.api.uiState.get().then(setUiState).catch(console.error)
    })
  }

  async function handleResetDefaults(): Promise<void> {
    setResetting(true)
    try {
      await window.api.footerActions.resetDefaults()
      const rows = await window.api.footerActions.listAtScope('global')
      setActions(rows)
    } catch (err) {
      console.error('[settings] resetDefaults failed', err)
    } finally {
      setResetting(false)
      setShowResetConfirm(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border-default bg-surface-raised p-4 text-sm text-red-400">
        Failed to load: {error}
      </div>
    )
  }

  if (!uiState) {
    return <SettingsSectionSkeleton />
  }

  return (
    <>
      {showResetConfirm && (
        <ConfirmModal
          title="Reset footer actions?"
          body={
            <p className="text-sm text-text-secondary">
              This will delete all global footer actions and restore the 6 default actions. Project-
              and workspace-scoped actions are not affected.
            </p>
          }
          confirmLabel={resetting ? 'Resetting…' : 'Reset to defaults'}
          destructive
          onConfirm={handleResetDefaults}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}

      <div className="space-y-0">
        <SettingRow
          label="Show workspace footer"
          description="Display a single-line action strip at the bottom of each workspace terminal."
        >
          <Toggle
            value={uiState.showWorkspaceFooter}
            onChange={toggleFooter}
            ariaLabel="Show workspace footer"
          />
        </SettingRow>
      </div>

      {/* Read-only action list */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Global footer actions
          </h3>
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="text-xs text-text-muted hover:text-text-primary transition-colors duration-150 px-2 py-1 rounded hover:bg-surface-overlay"
          >
            Reset to defaults
          </button>
        </div>

        {actionsLoading ? (
          <div className="text-xs text-text-muted">Loading…</div>
        ) : actions.length === 0 ? (
          <div className="text-xs text-text-muted">No global actions configured.</div>
        ) : (
          <div className="rounded-lg border border-border-default overflow-hidden">
            {actions.map((action, idx) => (
              <div
                key={action.id}
                className={[
                  'flex items-center gap-3 px-3 py-2.5 text-xs',
                  idx < actions.length - 1 ? 'border-b border-border-default/40' : ''
                ].join(' ')}
              >
                <span className="font-medium text-text-primary w-20 truncate flex-shrink-0">
                  {action.label}
                </span>
                <span className="text-text-muted truncate flex-1">{action.actionId}</span>
                <span className="text-[10px] font-mono text-text-muted/60 bg-surface-overlay px-1.5 py-0.5 rounded flex-shrink-0">
                  {action.scope}
                </span>
                {action.icon && (
                  <span className="text-[10px] text-text-muted/50 flex-shrink-0 font-mono">
                    {action.icon}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="mt-2 text-[11px] text-text-muted">
          Action editing will be available in a future update.
        </p>
      </div>
    </>
  )
}
