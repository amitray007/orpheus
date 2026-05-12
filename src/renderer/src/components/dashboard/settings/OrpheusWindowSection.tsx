import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// OrpheusWindowSection — window behavior, close/hide, last view restore
// ---------------------------------------------------------------------------

export function OrpheusWindowSection(): React.JSX.Element {
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
            description="Always on — Orpheus saves position, size, and fullscreen state and restores them at startup."
          >
            <div className="flex items-center gap-2">
              <div className="relative w-9 h-5 rounded-full bg-accent pointer-events-none opacity-60">
                <span className="absolute top-0.5 translate-x-[18px] w-4 h-4 rounded-full bg-white shadow-sm" />
              </div>
              <span className="text-[10px] text-text-muted italic">(always on)</span>
            </div>
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
            label="Close button hides instead of quits"
            description="Clicking the red close button keeps Orpheus running in the menu bar. Already implemented — toggle coming soon."
          >
            <div className="flex items-center gap-2">
              <div className="relative w-9 h-5 rounded-full bg-accent pointer-events-none opacity-60">
                <span className="absolute top-0.5 translate-x-[18px] w-4 h-4 rounded-full bg-white shadow-sm" />
              </div>
              <span className="text-[10px] text-text-muted italic">(always on)</span>
            </div>
          </SettingRow>
          <SettingRow
            label="Launch at login"
            description="Start Orpheus automatically when you log into macOS."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
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
            <div className="flex items-center gap-2">
              <div className="relative w-9 h-5 rounded-full bg-accent pointer-events-none opacity-60">
                <span className="absolute top-0.5 translate-x-[18px] w-4 h-4 rounded-full bg-white shadow-sm" />
              </div>
              <span className="text-[10px] text-text-muted italic">(always on)</span>
            </div>
          </SettingRow>
          <SettingRow
            label="Keyboard shortcut to show window"
            description="Global hotkey to bring Orpheus to the front from any app."
          >
            <div className="flex items-center gap-2">
              <div className="px-2.5 py-1 rounded border border-border-default bg-surface-overlay opacity-50 pointer-events-none">
                <span className="text-xs font-mono text-text-muted">⌘⇧O</span>
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

function DisabledToggle(): React.JSX.Element {
  return (
    <div className="relative w-9 h-5 rounded-full bg-surface-overlay border border-border-default pointer-events-none opacity-50">
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm" />
    </div>
  )
}
