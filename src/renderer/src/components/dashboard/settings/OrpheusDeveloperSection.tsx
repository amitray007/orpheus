import type React from 'react'
import { SettingRow, SectionTitle, Eyebrow } from './primitives'

export function OrpheusDeveloperSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Developer</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Diagnostics for debugging Orpheus itself. Different from the Claude developer section,
          which controls claude code&apos;s debug + telemetry flags.
        </p>
      </div>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Diagnostics</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Open DevTools"
            description="Open Chromium DevTools in a detached window. Console shows renderer logs. Main process logs go to stderr — visible if you launched Orpheus from the terminal."
          >
            <button
              type="button"
              onClick={() => {
                window.api.window.openDevTools().catch((err) => {
                  console.error('[settings] openDevTools failed', err)
                })
              }}
              className="text-xs px-3 py-1.5 rounded-md bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              Open DevTools
            </button>
          </SettingRow>
          <SettingRow
            label="Reload renderer"
            description="Force a renderer reload without restarting Orpheus. Useful after editing local renderer assets in dev mode."
          >
            <button
              type="button"
              onClick={() => {
                window.api.window.reload().catch((err) => {
                  console.error('[settings] reload failed', err)
                })
              }}
              className="text-xs px-3 py-1.5 rounded-md bg-surface-overlay text-text-primary border border-border-default hover:bg-surface-raised transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              Reload
            </button>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
