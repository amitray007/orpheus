import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState } from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

export function OrpheusDiagnosticsSection(): React.JSX.Element {
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
    setUiState({ ...uiState, ...p })
    window.api.uiState.update(p).catch((err) => {
      console.error('[settings] uiState update failed; refetching to reconcile', err)
      window.api.uiState
        .get()
        .then((s) => setUiState(s))
        .catch(console.error)
    })
  }

  const header = (
    <div>
      <SectionTitle>Diagnostics</SectionTitle>
      <p className="text-xs text-text-muted mt-1">
        Local-only event log for debugging. Data stays on this machine and is pruned after 7 days.
        Query it with <code className="text-text-secondary">bun run diag</code>.
      </p>
    </div>
  )

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        {header}
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
      </div>
    )
  }

  if (!uiState) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        {header}
        <SettingsSectionSkeleton groups={1} rowsPerGroup={4} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      {header}

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Capture</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Errors & crashes"
            description="Uncaught exceptions, unhandled rejections, and renderer errors. Recommended on."
          >
            <Toggle
              value={uiState.diagError ?? true}
              onChange={(v) => patch({ diagError: v })}
              ariaLabel="Capture errors and crashes"
            />
          </SettingRow>
          <SettingRow
            label="Lifecycle events"
            description="Breadcrumb trail: terminal mount/hide/destroy, workspace activity transitions."
          >
            <Toggle
              value={uiState.diagLifecycle ?? false}
              onChange={(v) => patch({ diagLifecycle: v })}
              ariaLabel="Capture lifecycle events"
            />
          </SettingRow>
          <SettingRow
            label="Performance metrics"
            description="Timings such as terminal mount duration."
          >
            <Toggle
              value={uiState.diagPerf ?? false}
              onChange={(v) => patch({ diagPerf: v })}
              ariaLabel="Capture performance metrics"
            />
          </SettingRow>
          <SettingRow
            label="Anomalies"
            description="Self-detected problems: watchdog demotions, terminal focus reclaims."
          >
            <Toggle
              value={uiState.diagAnomaly ?? false}
              onChange={(v) => patch({ diagAnomaly: v })}
              ariaLabel="Capture anomalies"
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
