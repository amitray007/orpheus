import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState } from '@shared/types'
import { SettingRow, Toggle } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// OrpheusWindowSection — window behavior, close/hide, last view restore
// ---------------------------------------------------------------------------

export function OrpheusWindowSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.uiState
      .get()
      .then((s) => {
        if (!cancelled) setUiState(s)
      })
      .catch((err) => {
        console.error('[settings] failed to load uiState', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<AppUiState>): void {
    if (!uiState) return
    // Optimistic update
    setUiState({ ...uiState, ...p })
    window.api.uiState.update(p).catch((err) => {
      console.error('[settings] uiState update failed; refetching to reconcile', err)
      window.api.uiState
        .get()
        .then((s) => setUiState(s))
        .catch(console.error)
    })
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Window</h2>
          <p className="text-xs text-text-muted mt-1">
            Geometry persistence, close behavior, and what view Orpheus opens to on launch.
          </p>
        </div>
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
      </div>
    )
  }

  if (!uiState) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Window</h2>
          <p className="text-xs text-text-muted mt-1">
            Geometry persistence, close behavior, and what view Orpheus opens to on launch.
          </p>
        </div>
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Window</h2>
        <p className="text-xs text-text-muted mt-1">
          Geometry persistence, close behavior, and what view Orpheus opens to on launch.
        </p>
      </div>

      {/* Geometry */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Geometry
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Restore window geometry on launch"
            description="Reopen at the same size and position as last quit. When off, Orpheus always opens at 1280×800 centered."
          >
            <Toggle
              value={uiState.restoreGeometry ?? true}
              onChange={(v) => patch({ restoreGeometry: v })}
              ariaLabel="Restore window geometry"
            />
          </SettingRow>
        </div>
      </section>

      {/* Close behavior */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Close behavior
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Close button hides Orpheus"
            description="On macOS, clicking the red close button hides the app instead of quitting. ⌘Q still quits."
          >
            <Toggle
              value={uiState.closeHides ?? true}
              onChange={(v) => patch({ closeHides: v })}
              ariaLabel="Close button hides Orpheus"
            />
          </SettingRow>
        </div>
      </section>

      {/* Navigation */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Navigation
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Open at last view"
            description="Re-open the project, workspace, or dashboard you had active when Orpheus last closed."
          >
            <Toggle
              value={uiState.openAtLastView ?? true}
              onChange={(v) => patch({ openAtLastView: v })}
              ariaLabel="Open at last view"
            />
          </SettingRow>
        </div>
      </section>

      {/* Coming soon */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Coming soon
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Launch at login"
            description="Start Orpheus automatically when you log into macOS."
          >
            <ComingSoonChip />
          </SettingRow>
          <SettingRow
            label="Global hotkey"
            description="System-wide keyboard shortcut to bring Orpheus to the front from any app."
          >
            <ComingSoonChip />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
