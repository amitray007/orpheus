import { useEffect, useState } from 'react'
import type React from 'react'
import type { KeepAwakeBaseMode, KeepAwakeState } from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'

const MODE_OPTIONS: Array<{ id: KeepAwakeBaseMode; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'auto', label: 'Auto' },
  { id: 'on', label: 'On' }
]

export function OrpheusKeepAwakeSection(): React.JSX.Element {
  const [state, setState] = useState<KeepAwakeState | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.keepAwake
      .get()
      .then((s) => {
        if (!cancelled) setState(s)
      })
      .catch(console.error)
    const off = window.api.keepAwake.onState((s) => setState(s))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  if (!state) return <div className="text-sm text-text-muted">Loading…</div>

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Keep Awake</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Prevent your Mac from sleeping while Claude agents are working.
        </p>
      </div>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Behavior</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Default mode"
            description="Auto keeps the Mac awake only while agents are running. On stays awake until turned off. Off respects normal sleep settings."
          >
            <div className="inline-flex rounded-md border border-border-default overflow-hidden">
              {MODE_OPTIONS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => window.api.keepAwake.setMode(m.id).catch(console.error)}
                  className={[
                    'px-3 py-1.5 text-xs cursor-pointer transition-colors',
                    state.baseMode === m.id
                      ? 'bg-accent text-white'
                      : 'text-text-secondary hover:bg-surface-overlay'
                  ].join(' ')}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            label="Also keep the display on"
            description="When off, the system stays awake but the screen can still sleep (saves power). When on, the screen stays lit too."
          >
            <Toggle
              ariaLabel="Also keep the display on"
              value={state.keepDisplayOn}
              onChange={(v) => window.api.keepAwake.setDisplayOn(v).catch(console.error)}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
