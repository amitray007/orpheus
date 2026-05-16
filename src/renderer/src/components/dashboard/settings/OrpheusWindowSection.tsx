import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { AppUiState } from '@shared/types'
import { SettingRow, Toggle } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// HotkeyInput — inline key-capture component
// ---------------------------------------------------------------------------

function normalizeKey(key: string): string {
  if (key.length === 1) return key.toUpperCase()
  const map: Record<string, string> = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Enter: 'Return',
    ' ': 'Space'
  }
  return map[key] ?? key
}

interface HotkeyInputProps {
  value: string
  onChange: (accel: string) => void
}

function HotkeyInput({ value, onChange }: HotkeyInputProps): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const captureRef = useRef(false)

  function startCapture(): void {
    setCapturing(true)
    captureRef.current = true
  }

  function exitCapture(): void {
    setCapturing(false)
    captureRef.current = false
  }

  useEffect(() => {
    if (!capturing) return

    function onKeyDown(e: KeyboardEvent): void {
      e.preventDefault()
      e.stopPropagation()

      // Escape with no modifiers → cancel
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        exitCapture()
        return
      }

      // Skip bare modifier keystrokes — keep waiting
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return

      const parts: string[] = []
      if (e.metaKey || e.ctrlKey) parts.push('CommandOrControl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')

      // Require at least one non-shift modifier
      if (parts.length === 0 || (parts.length === 1 && parts[0] === 'Shift')) {
        return // keep waiting
      }

      const mainKey = normalizeKey(e.key)
      parts.push(mainKey)

      onChange(parts.join('+'))
      exitCapture()
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, onChange])

  return (
    <div className="flex items-center gap-2">
      {capturing ? (
        <button
          type="button"
          onClick={exitCapture}
          className="px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-brand-accent text-text-muted font-mono min-w-[160px] text-left cursor-pointer animate-pulse"
        >
          Press a key combo… (Esc to cancel)
        </button>
      ) : (
        <button
          type="button"
          onClick={startCapture}
          className="px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default hover:border-border-hover text-text-primary font-mono min-w-[160px] text-left cursor-pointer transition-colors"
        >
          {value || <span className="text-text-muted font-sans">None</span>}
        </button>
      )}
      {value && !capturing && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="text-xs text-text-muted hover:text-text-primary transition-colors px-1.5 py-1 rounded hover:bg-surface-overlay"
          aria-label="Clear hotkey"
        >
          Clear
        </button>
      )}
    </div>
  )
}

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
        <SettingsSectionSkeleton groups={2} rowsPerGroup={2} />
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

      {/* Launch + hotkey */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Launch + hotkey
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Launch at login"
            description="Start Orpheus automatically when you log into macOS."
          >
            <Toggle
              value={uiState.launchAtLogin}
              onChange={(v) => patch({ launchAtLogin: v })}
              ariaLabel="Launch at login"
            />
          </SettingRow>
          <SettingRow
            label="Global hotkey"
            description="System-wide keyboard shortcut to bring Orpheus to the front from any app."
          >
            <HotkeyInput
              value={uiState.globalHotkey}
              onChange={(accel) => patch({ globalHotkey: accel })}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
