import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { AppUiState, UpdateCheckResult } from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { ComingSoonChip } from './ClaudeGeneralSection'
import { DotmSquare11 } from '@/components/ui/dotm-square-11'
import { DotmSquare18 } from '@/components/ui/dotm-square-18'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UpdateState =
  | { kind: 'idle'; lastChecked: number | null }
  | { kind: 'checking' }
  | { kind: 'up_to_date'; lastChecked: number; latest: string }
  | { kind: 'available'; latest: string; lastChecked: number }
  | { kind: 'installing'; lastLine: string }
  | { kind: 'install_done' }
  | { kind: 'error'; reason: string; lastChecked: number }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ---------------------------------------------------------------------------
// OrpheusUpdatesSection
// ---------------------------------------------------------------------------

export function OrpheusUpdatesSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle', lastChecked: null })
  const cleanupRef = useRef<(() => void)[]>([])

  function applyCheckResult(result: UpdateCheckResult): void {
    if (result.error) {
      setUpdateState({ kind: 'error', reason: result.error, lastChecked: result.checkedAt })
    } else if (result.available && result.latest) {
      setUpdateState({ kind: 'available', latest: result.latest, lastChecked: result.checkedAt })
    } else {
      setUpdateState({
        kind: 'up_to_date',
        lastChecked: result.checkedAt,
        latest: result.latest ?? ''
      })
    }
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.uiState.get(), window.api.app.getVersion()])
      .then(([s, v]) => {
        if (cancelled) return
        setUiState(s)
        setVersion(v)
      })
      .catch(console.error)

    const offProgress = window.api.updates.onProgress(({ line }) => {
      setUpdateState((prev) => ({
        kind: 'installing',
        lastLine: line.trim() || (prev.kind === 'installing' ? prev.lastLine : '')
      }))
    })
    const offDone = window.api.updates.onDone(({ success }) => {
      setUpdateState(
        success
          ? { kind: 'install_done' }
          : { kind: 'error', reason: 'brew upgrade failed', lastChecked: Date.now() }
      )
    })
    const offResult = window.api.updates.onCheckResult((result) => {
      applyCheckResult(result)
    })

    cleanupRef.current = [offProgress, offDone, offResult]
    return () => {
      cancelled = true
      for (const fn of cleanupRef.current) fn()
    }
  }, [])

  async function handleCheck(): Promise<void> {
    setUpdateState({ kind: 'checking' })
    try {
      const result = await window.api.updates.check()
      applyCheckResult(result)
    } catch (err) {
      setUpdateState({
        kind: 'error',
        reason: err instanceof Error ? err.message : String(err),
        lastChecked: Date.now()
      })
    }
  }

  function handleInstall(): void {
    setUpdateState({ kind: 'installing', lastLine: 'Starting brew upgrade...' })
    window.api.updates.install().catch(console.error)
  }

  function handleRestart(): void {
    window.api.updates.restart().catch(console.error)
  }

  function handleLater(): void {
    setUpdateState({ kind: 'idle', lastChecked: Date.now() })
  }

  function patchAutoCheck(v: boolean): void {
    if (!uiState) return
    const next = { ...uiState, autoCheckUpdates: v }
    setUiState(next)
    window.api.uiState.update({ autoCheckUpdates: v }).catch(console.error)
  }

  if (!uiState || version === null) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Updates</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Control how and when Orpheus checks for and applies updates.
          </p>
        </div>
        <SettingsSectionSkeleton groups={3} rowsPerGroup={1} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Updates</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Control how and when Orpheus checks for and applies updates.
        </p>
      </div>

      {/* Release channel */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Release channel</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Update channel"
            description="Stable receives tested releases. Beta gets early access to new features."
          >
            <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5">
              <button
                type="button"
                className="px-3 py-1.5 text-xs font-medium rounded bg-accent/15 text-text-primary cursor-default"
                aria-pressed="true"
              >
                Stable
              </button>
              <div className="relative flex items-center opacity-50 cursor-not-allowed select-none">
                <span className="px-3 py-1.5 text-xs font-medium text-text-muted">Beta</span>
                <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide bg-surface-overlay border border-border-default text-text-muted rounded px-1 py-0.5 leading-none">
                  Soon
                </span>
              </div>
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Update policy */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Update policy</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-check for updates"
            description="Periodically check for new Orpheus releases in the background."
          >
            <Toggle
              value={uiState.autoCheckUpdates ?? true}
              onChange={patchAutoCheck}
              ariaLabel="Auto-check for updates"
            />
          </SettingRow>
          <SettingRow
            label="Auto-install updates"
            description="Download and apply updates automatically on next launch."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Manual check */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Manual</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">
                You&apos;re on Orpheus v{version}
              </p>
              <p className="text-xs text-text-muted mt-0.5">
                Check against the latest release on GitHub.
              </p>
            </div>
            <button
              type="button"
              disabled={updateState.kind === 'checking' || updateState.kind === 'installing'}
              onClick={() => {
                void handleCheck()
              }}
              className="flex-shrink-0 px-4 py-2 rounded-md text-xs font-medium bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Check now
            </button>
          </div>

          {/* State display */}
          <div className="mt-3 min-h-[24px]">
            <UpdateStateDisplay
              state={updateState}
              onInstall={handleInstall}
              onRestart={handleRestart}
              onLater={handleLater}
              onRetry={() => {
                void handleCheck()
              }}
            />
          </div>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// UpdateStateDisplay
// ---------------------------------------------------------------------------

function UpdateStateDisplay({
  state,
  onInstall,
  onRestart,
  onLater,
  onRetry
}: {
  state: UpdateState
  onInstall: () => void
  onRestart: () => void
  onLater: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  if (state.kind === 'idle') {
    return (
      <p className="text-xs text-text-muted">
        {state.lastChecked ? `Last checked: ${timeAgo(state.lastChecked)}` : 'Last checked: never'}
      </p>
    )
  }

  if (state.kind === 'checking') {
    return (
      <div className="flex items-center gap-2">
        <DotmSquare11 size={14} dotSize={1.5} animated />
        <span className="text-xs text-text-secondary">Checking...</span>
      </div>
    )
  }

  if (state.kind === 'up_to_date') {
    return (
      <p className="text-xs text-text-muted">
        You&apos;re on the latest version &middot; Last checked: {timeAgo(state.lastChecked)}
      </p>
    )
  }

  if (state.kind === 'available') {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-text-primary">Orpheus v{state.latest} is available</span>
        <button
          type="button"
          onClick={onInstall}
          className="px-3 py-1 rounded text-xs font-medium bg-accent text-black hover:bg-accent/90 transition-colors cursor-pointer"
        >
          Install Update
        </button>
      </div>
    )
  }

  if (state.kind === 'installing') {
    return (
      <div className="flex items-start gap-2">
        <DotmSquare18 size={20} dotSize={2} animated />
        <p className="text-xs text-text-muted italic leading-tight mt-0.5 break-all">
          {state.lastLine}
        </p>
      </div>
    )
  }

  if (state.kind === 'install_done') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-primary">Update installed</span>
        <button
          type="button"
          onClick={onRestart}
          className="px-3 py-1 rounded text-xs font-medium bg-accent text-black hover:bg-accent/90 transition-colors cursor-pointer"
        >
          Restart Now
        </button>
        <button
          type="button"
          onClick={onLater}
          className="px-3 py-1 rounded text-xs font-medium text-text-muted border border-border-default hover:text-text-secondary transition-colors cursor-pointer"
        >
          Later
        </button>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-red-400">Update failed: {state.reason}</span>
        <button
          type="button"
          onClick={onRetry}
          className="text-xs text-accent hover:underline cursor-pointer"
        >
          Retry
        </button>
      </div>
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// DisabledToggle — static, non-interactive toggle for "coming soon" rows
// ---------------------------------------------------------------------------

function DisabledToggle({ checked = false }: { checked?: boolean }): React.JSX.Element {
  return (
    <div
      className={[
        'relative w-9 h-5 rounded-full pointer-events-none opacity-50',
        checked ? 'bg-accent' : 'bg-surface-overlay border border-border-default'
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        ].join(' ')}
      />
    </div>
  )
}
