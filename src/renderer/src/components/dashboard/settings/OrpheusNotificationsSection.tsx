import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState } from '@shared/types'
import { SettingRow, Toggle, NumberInput, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

export function OrpheusNotificationsSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

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

  async function handleTestNotification(): Promise<void> {
    setTesting(true)
    try {
      await window.api.notifications.test()
    } catch (err) {
      console.error('[settings] test notification failed', err)
    } finally {
      setTesting(false)
    }
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Notifications</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Native macOS alerts for Claude activity transitions.
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
          <SectionTitle>Notifications</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Native macOS alerts for Claude activity transitions.
          </p>
        </div>
        <SettingsSectionSkeleton groups={2} rowsPerGroup={2} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Notifications</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Native macOS alerts for Claude activity transitions.
        </p>
      </div>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Events</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Claude needs you"
            description="Notify when Claude pauses on a permission request or tool-use confirmation."
          >
            <Toggle
              value={uiState.notifyAttention ?? true}
              onChange={(v) => patch({ notifyAttention: v })}
              ariaLabel="Notify when Claude needs you"
            />
          </SettingRow>
          <SettingRow
            label="Claude finished a response"
            description="Notify when Claude's reply is ready for your next message."
          >
            <Toggle
              value={uiState.notifyStop ?? true}
              onChange={(v) => patch({ notifyStop: v })}
              ariaLabel="Notify when Claude finishes"
            />
          </SettingRow>
          <SettingRow
            label="Detailed finish summary"
            description="Show how long the turn took and how many subagents ran in the 'Claude finished' notification."
          >
            <Toggle
              value={uiState.notifyRichSummary ?? true}
              onChange={(v) => patch({ notifyRichSummary: v })}
              ariaLabel="Show detailed finish summary"
            />
          </SettingRow>
          <SettingRow
            label="Repeat attention reminders"
            description="When Claude is waiting on you, keep re-notifying on an exponential schedule (30s, 1m, 2m, 4m, 8m, then every 8m) until you view that workspace. Set to 0 to disable repeats."
          >
            <NumberInput
              value={uiState.notifyMaxAttentionRepeats ?? 5}
              onChange={(v) => patch({ notifyMaxAttentionRepeats: Math.max(0, v ?? 0) })}
              placeholder="5"
            />
          </SettingRow>
        </div>
      </section>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Behavior</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Notify even when Orpheus is focused"
            description="By default, notifications are suppressed when you are already viewing the workspace they belong to. Enable to always notify."
          >
            <Toggle
              value={uiState.notifyAlways ?? false}
              onChange={(v) => patch({ notifyAlways: v })}
              ariaLabel="Notify even when Orpheus is focused"
            />
          </SettingRow>
          <SettingRow
            label="Suppress finish notifications when focused"
            description="When Orpheus has focus, skip 'Claude finished' notifications for all workspaces (not just the one you're viewing). Permission and attention notifications still fire."
          >
            <Toggle
              value={uiState.notifySuppressWhenFocused ?? false}
              onChange={(v) => patch({ notifySuppressWhenFocused: v })}
              ariaLabel="Suppress finish notifications when Orpheus is focused"
            />
          </SettingRow>
        </div>
      </section>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Test</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-text-primary">Test notification</span>
              <span className="text-xs text-text-muted">
                Fire a sample macOS notification to confirm the system allows Orpheus alerts.
              </span>
            </div>
            <button
              type="button"
              onClick={handleTestNotification}
              disabled={testing}
              className="flex-shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-surface-overlay border border-border-default hover:border-border-hover text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing ? 'Sending...' : 'Send test'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
