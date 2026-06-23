import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState } from '@shared/types'
import { SettingRow, NumberInput, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

export function OrpheusWorkspacesSection(): React.JSX.Element {
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

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Workspaces</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Activity tracking and lifecycle for your workspaces.
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
          <SectionTitle>Workspaces</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Activity tracking and lifecycle for your workspaces.
          </p>
        </div>
        <SettingsSectionSkeleton groups={1} rowsPerGroup={3} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Workspaces</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Activity tracking and lifecycle for your workspaces.
        </p>
      </div>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Activity &amp; lifecycle</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Inactivity watchdog (seconds)"
            description="When the working spinner has been stuck with no PreToolUse / PostToolUse / PreCompact / SubagentStop heartbeat for this many seconds, demote it to Ready. Catches user-interrupt cases (Ctrl-C, Esc) where Claude never fires Stop. Set to 0 to disable."
          >
            <NumberInput
              value={uiState.inProgressWatchdogSec ?? 120}
              onChange={(v) => patch({ inProgressWatchdogSec: Math.max(0, v ?? 0) })}
              placeholder="120"
            />
          </SettingRow>
          <SettingRow
            label="Workspace stale threshold (minutes)"
            description="When a workspace's agent has had no new activity for this many minutes, the sidebar marks it stale (a clock glyph and dimmed text). Helps surface forgotten or long-idle workspaces."
          >
            <NumberInput
              value={uiState.staleAfterMinutes ?? 60}
              onChange={(v) => patch({ staleAfterMinutes: Math.max(1, v ?? 60) })}
              placeholder="60"
            />
          </SettingRow>
          <SettingRow
            label="Auto-close idle workspaces after (minutes)"
            description="Closing frees a workspace's resources (terminal + claude process) while keeping it in your list; click it to reopen and resume. Set to 0 to disable."
          >
            <NumberInput
              value={uiState.autoCloseAfterMinutes ?? 120}
              onChange={(v) => patch({ autoCloseAfterMinutes: Math.max(0, v ?? 120) })}
              placeholder="120"
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
