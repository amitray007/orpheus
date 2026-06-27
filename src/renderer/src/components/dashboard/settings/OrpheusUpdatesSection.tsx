import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type {
  AppUiState,
  UpdateCheckResult,
  UpdatePhase,
  UpdateProgress,
  UpdateSnapshot
} from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { DotmSquare11 } from '@/components/ui/dotm-square-11'
import { DotmSquare18 } from '@/components/ui/dotm-square-18'

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

type UpdateState =
  | { kind: 'idle'; lastChecked: number | null }
  | { kind: 'checking' }
  | { kind: 'up_to_date'; lastChecked: number; latest: string }
  | { kind: 'available'; latest: string; lastChecked: number }
  | {
      kind: 'installing'
      phase: UpdatePhase
      percent: number | null
      log: string[]
      latest: string
    }
  | { kind: 'installed'; latest: string }
  | { kind: 'error'; reason: string; log: string[] }

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

const LOG_CAP = 200

function appendLog(prev: string[], line: string): string[] {
  const next = [...prev, line]
  return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next
}

function snapshotToState(snap: UpdateSnapshot): UpdateState {
  switch (snap.kind) {
    case 'checking':
      return { kind: 'checking' }
    case 'up_to_date':
      return { kind: 'up_to_date', lastChecked: snap.lastChecked ?? 0, latest: snap.latest ?? '' }
    case 'available':
      return { kind: 'available', latest: snap.latest ?? '', lastChecked: snap.lastChecked ?? 0 }
    case 'installing':
      return {
        kind: 'installing',
        phase: snap.phase ?? 'refresh',
        percent: snap.percent,
        log: snap.log,
        latest: snap.latest ?? ''
      }
    case 'installed':
      return { kind: 'installed', latest: snap.latest ?? '' }
    case 'error':
      return { kind: 'error', reason: snap.reason ?? 'Update failed', log: snap.log }
    default:
      return { kind: 'idle', lastChecked: snap.lastChecked }
  }
}

// ---------------------------------------------------------------------------
// PhaseStepper
// ---------------------------------------------------------------------------

const PHASES: { key: UpdatePhase; label: string }[] = [
  { key: 'refresh', label: 'Refresh' },
  { key: 'download', label: 'Download' },
  { key: 'verify', label: 'Verify' },
  { key: 'install', label: 'Install' }
]

const PHASE_ORDER: UpdatePhase[] = ['refresh', 'download', 'verify', 'install']

function PhaseStepper({ phase }: { phase: UpdatePhase }): React.JSX.Element {
  const currentIdx = PHASE_ORDER.indexOf(phase)
  return (
    <div className="flex items-center gap-1">
      {PHASES.map(({ key, label }, idx) => {
        const done = idx < currentIdx
        const active = idx === currentIdx
        return (
          <div key={key} className="flex items-center gap-1">
            <span
              className={[
                'text-xs',
                done
                  ? 'text-text-muted line-through'
                  : active
                    ? 'text-accent font-medium'
                    : 'text-text-muted'
              ].join(' ')}
            >
              {label}
            </span>
            {idx < PHASES.length - 1 && <span className="text-text-muted text-xs">→</span>}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProgressBar — determinate or indeterminate
// ---------------------------------------------------------------------------

function ProgressBar({ percent }: { percent: number | null }): React.JSX.Element {
  if (percent !== null) {
    return (
      <div className="w-full h-1 rounded-full bg-surface-overlay overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
    )
  }
  // Indeterminate — animated shimmer
  return (
    <div className="w-full h-1 rounded-full bg-surface-overlay overflow-hidden">
      <div className="h-full bg-accent/70 rounded-full animate-indeterminate" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// LogDisclosure
// ---------------------------------------------------------------------------

function LogDisclosure({ log }: { log: string[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [log, open])

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors cursor-pointer w-fit"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>{open ? 'Hide log' : 'Show log'}</span>
      </button>
      {open && (
        <pre className="text-xs text-text-muted font-mono bg-surface-overlay border border-border-default rounded p-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
          {log.join('\n') || '(no output yet)'}
          <div ref={logEndRef} />
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dev-only debug seam — step through states without a real update
// Gated strictly: only renders when __ORPHEUS_MODE__ === 'development'
// ---------------------------------------------------------------------------

const fakeLog = [
  '==> Downloading orpheus-0.6.0.dmg',
  '  ###   5.0%',
  '==> Verifying checksum',
  '==> Installing orpheus'
]

function DevStateControls({
  onSet
}: {
  onSet: (s: UpdateState) => void
}): React.JSX.Element | null {
  if (__ORPHEUS_MODE__ !== 'development') return null

  return (
    <div className="mt-3 p-2 border border-dashed border-border-default rounded text-xs text-text-muted flex flex-wrap gap-1">
      <span className="font-mono mr-1">[dev]</span>
      {(
        [
          ['idle', () => onSet({ kind: 'idle', lastChecked: null })],
          ['checking', () => onSet({ kind: 'checking' })],
          [
            'up_to_date',
            () => onSet({ kind: 'up_to_date', lastChecked: Date.now(), latest: '0.5.0' })
          ],
          [
            'available',
            () => onSet({ kind: 'available', latest: '0.6.0', lastChecked: Date.now() })
          ],
          [
            'refresh',
            () =>
              onSet({
                kind: 'installing',
                phase: 'refresh',
                percent: null,
                log: fakeLog,
                latest: '0.6.0'
              })
          ],
          [
            'download 42%',
            () =>
              onSet({
                kind: 'installing',
                phase: 'download',
                percent: 42,
                log: fakeLog,
                latest: '0.6.0'
              })
          ],
          [
            'verify',
            () =>
              onSet({
                kind: 'installing',
                phase: 'verify',
                percent: null,
                log: fakeLog,
                latest: '0.6.0'
              })
          ],
          [
            'install',
            () =>
              onSet({
                kind: 'installing',
                phase: 'install',
                percent: null,
                log: fakeLog,
                latest: '0.6.0'
              })
          ],
          ['installed', () => onSet({ kind: 'installed', latest: '0.6.0' })],
          ['error', () => onSet({ kind: 'error', reason: 'brew upgrade failed', log: fakeLog })]
        ] as [string, () => void][]
      ).map(([label, fn]) => (
        <button
          key={label}
          type="button"
          onClick={fn}
          className="px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default hover:bg-accent/10 cursor-pointer"
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OrpheusUpdatesSection
// ---------------------------------------------------------------------------

function handleRestart(): void {
  window.api.updates.restart().catch(console.error)
}

export function OrpheusUpdatesSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle', lastChecked: null })
  const cleanupRef = useRef<(() => void)[]>([])
  // Track the target version for the install in flight so onDone can report it correctly
  const installTargetRef = useRef<string | null>(null)

  function applyCheckResult(result: UpdateCheckResult): void {
    if (result.error) {
      setUpdateState({ kind: 'error', reason: result.error, log: [] })
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

    // Rehydrate update state from main — survives navigation away and back
    window.api.updates
      .getState()
      .then((snap) => {
        if (!cancelled) setUpdateState(snapshotToState(snap))
      })
      .catch(console.error)

    const offProgress = window.api.updates.onProgress((progress: UpdateProgress) => {
      setUpdateState((prev) => {
        const prevLog =
          prev.kind === 'installing' ? prev.log : prev.kind === 'error' ? prev.log : []
        return {
          kind: 'installing',
          phase: progress.phase,
          percent: progress.percent,
          log: appendLog(prevLog, progress.line),
          latest: prev.kind === 'installing' ? prev.latest : (installTargetRef.current ?? '')
        }
      })
    })
    const offDone = window.api.updates.onDone(({ success, code }) => {
      setUpdateState((prev) => {
        if (success) {
          return { kind: 'installed', latest: installTargetRef.current ?? '' }
        }
        const prevLog = prev.kind === 'installing' ? prev.log : []
        return {
          kind: 'error',
          reason: `brew upgrade exited with code ${code ?? 'unknown'}`,
          log: prevLog
        }
      })
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
        log: []
      })
    }
  }

  function handleInstall(target: string): void {
    installTargetRef.current = target
    setUpdateState({ kind: 'installing', phase: 'refresh', percent: null, log: [], latest: target })
    window.api.updates.install().catch(console.error)
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

  const isInFlight = updateState.kind === 'checking' || updateState.kind === 'installing'

  if (!uiState || version === null) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Updates</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Control how and when Orpheus checks for and applies updates.
          </p>
        </div>
        <SettingsSectionSkeleton groups={2} rowsPerGroup={1} />
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

      {/* Update card */}
      <section className="flex flex-col">
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          {/* Header row — always shown */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">
                You&apos;re on Orpheus v{version}
              </p>
              <CardSubline state={updateState} />
            </div>
            <button
              type="button"
              disabled={isInFlight}
              onClick={() => {
                void handleCheck()
              }}
              className="flex-shrink-0 px-4 py-2 rounded-md text-xs font-medium bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Check now
            </button>
          </div>

          {/* State-specific content below the header */}
          <div className="mt-3">
            <CardBody
              state={updateState}
              onInstall={(target) => handleInstall(target)}
              onRestart={handleRestart}
              onLater={handleLater}
              onRetry={() => void handleCheck()}
            />
          </div>

          {/* Dev-only debug controls */}
          <DevStateControls onSet={setUpdateState} />
        </div>
      </section>

      {/* Preferences */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Preferences</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-check for updates"
            description="Quietly look for new releases in the background (every 6h)."
          >
            <Toggle
              value={uiState.autoCheckUpdates ?? true}
              onChange={patchAutoCheck}
              ariaLabel="Auto-check for updates"
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CardSubline — the subtitle line beneath "You're on Orpheus v…"
// ---------------------------------------------------------------------------

function CardSubline({ state }: { state: UpdateState }): React.JSX.Element | null {
  if (state.kind === 'idle') {
    return (
      <p className="text-xs text-text-muted mt-0.5">
        {state.lastChecked ? `Last checked ${timeAgo(state.lastChecked)}` : 'Never checked'}
      </p>
    )
  }
  if (state.kind === 'checking') {
    return null
  }
  if (state.kind === 'up_to_date') {
    return (
      <p className="text-xs text-text-muted mt-0.5">
        Up to date &middot; last checked {timeAgo(state.lastChecked)}
      </p>
    )
  }
  if (state.kind === 'available') {
    return (
      <p className="text-xs text-text-muted mt-0.5">Update available &middot; v{state.latest}</p>
    )
  }
  if (state.kind === 'installing') {
    return (
      <p className="text-xs text-text-muted mt-0.5">
        {state.latest ? `Installing v${state.latest}…` : 'Installing…'}
      </p>
    )
  }
  if (state.kind === 'installed') {
    return (
      <p className="text-xs text-text-muted mt-0.5">
        Updated to v{state.latest} &middot; restart to finish
      </p>
    )
  }
  if (state.kind === 'error') {
    return <p className="text-xs text-red-400 mt-0.5">Update failed</p>
  }
  return <p className="text-xs text-text-muted mt-0.5" />
}

// ---------------------------------------------------------------------------
// CardBody — phase-specific expanded content
// ---------------------------------------------------------------------------

function CardBody({
  state,
  onInstall,
  onRestart,
  onLater,
  onRetry
}: {
  state: UpdateState
  onInstall: (version: string) => void
  onRestart: () => void
  onLater: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  if (state.kind === 'idle') {
    return null
  }

  if (state.kind === 'checking') {
    return (
      <div className="flex items-center gap-2">
        <DotmSquare11 size={14} dotSize={1.5} animated />
        <span className="text-xs text-text-secondary">Checking for updates…</span>
      </div>
    )
  }

  if (state.kind === 'up_to_date') {
    return null
  }

  if (state.kind === 'available') {
    return (
      <div>
        <button
          type="button"
          onClick={() => onInstall(state.latest)}
          className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-black hover:bg-accent/90 transition-colors cursor-pointer"
        >
          Install v{state.latest}
        </button>
      </div>
    )
  }

  if (state.kind === 'installing') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <DotmSquare18 size={16} dotSize={1.5} animated />
          <PhaseStepper phase={state.phase} />
        </div>
        <ProgressBar percent={state.percent} />
        <LogDisclosure log={state.log} />
      </div>
    )
  }

  if (state.kind === 'installed') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-primary">Updated to v{state.latest}</span>
        <button
          type="button"
          onClick={onRestart}
          className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-black hover:bg-accent/90 transition-colors cursor-pointer"
        >
          Restart now
        </button>
        <button
          type="button"
          onClick={onLater}
          className="px-3 py-1.5 rounded text-xs font-medium text-text-muted border border-border-default hover:text-text-secondary transition-colors cursor-pointer"
        >
          Later
        </button>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-red-400">{state.reason}</span>
          <button
            type="button"
            onClick={onRetry}
            className="text-xs text-accent hover:underline cursor-pointer"
          >
            Retry
          </button>
        </div>
        <LogDisclosure log={state.log} />
      </div>
    )
  }

  return null
}
