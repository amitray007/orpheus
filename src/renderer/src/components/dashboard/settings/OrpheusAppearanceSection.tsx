import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// OrpheusAppearanceSection — theme, accent color, font size
// ---------------------------------------------------------------------------

const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' }
] as const

const ACCENT_COLORS = [
  { value: 'purple', label: 'Purple', hex: '#9B6CFF' },
  { value: 'blue', label: 'Blue', hex: '#3B8EFF' },
  { value: 'teal', label: 'Teal', hex: '#2CC3A8' },
  { value: 'orange', label: 'Orange', hex: '#FF8C42' },
  { value: 'pink', label: 'Pink', hex: '#FF5FA0' }
] as const

export function OrpheusAppearanceSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Appearance</h2>
        <p className="text-xs text-text-muted mt-1">
          Theme, accent color, and font size scale for the Orpheus UI.
        </p>
      </div>

      {/* Theme */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Theme
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Color theme"
            description="Dark is the only available theme for now. Light and System auto-switch are planned."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {THEME_OPTIONS.map((opt) => (
                  <span
                    key={opt.value}
                    className={[
                      'px-3 py-1.5 text-xs font-medium rounded',
                      opt.value === 'dark' ? 'bg-accent/15 text-text-primary' : 'text-text-muted'
                    ].join(' ')}
                  >
                    {opt.label}
                  </span>
                ))}
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Accent color */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Accent color
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Accent"
            description="Used for active states, highlights, and interactive elements throughout the UI."
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 opacity-50 pointer-events-none">
                {ACCENT_COLORS.map((c) => (
                  <div
                    key={c.value}
                    title={c.label}
                    className={[
                      'w-6 h-6 rounded-full border-2',
                      c.value === 'purple'
                        ? 'border-white/60 ring-1 ring-white/30'
                        : 'border-transparent'
                    ].join(' ')}
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Font size */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Typography
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="UI font size scale"
            description="Scales all text in the Orpheus chrome (sidebar, settings, panels). Does not affect the terminal."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Small', 'Default', 'Large'] as const).map((s) => (
                  <span
                    key={s}
                    className={[
                      'px-3 py-1.5 text-xs font-medium rounded',
                      s === 'Default' ? 'bg-accent/15 text-text-primary' : 'text-text-muted'
                    ].join(' ')}
                  >
                    {s}
                  </span>
                ))}
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
