import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// OrpheusUpdatesSection — auto-update, channel, check now
// ---------------------------------------------------------------------------

export function OrpheusUpdatesSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Updates</h2>
        <p className="text-xs text-text-muted mt-1">
          Control how and when Orpheus checks for and applies updates.
        </p>
      </div>

      {/* Auto-update */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Update policy
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-check for updates"
            description="Periodically check for new Orpheus releases in the background."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle checked />
              <ComingSoonChip />
            </div>
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

      {/* Channel */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Release channel
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Update channel"
            description="Stable receives tested releases. Beta gets early access to new features."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Stable', 'Beta'] as const).map((c) => (
                  <span
                    key={c}
                    className={[
                      'px-3 py-1.5 text-xs font-medium rounded',
                      c === 'Stable' ? 'bg-accent/15 text-text-primary' : 'text-text-muted'
                    ].join(' ')}
                  >
                    {c}
                  </span>
                ))}
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Manual check */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Manual
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">Check for updates now</p>
              <p className="text-xs text-text-muted mt-0.5">
                Manually trigger an update check against the release channel.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                disabled
                className="px-4 py-2 rounded-md text-xs font-medium bg-accent/10 text-accent border border-accent/20 opacity-50 cursor-not-allowed"
              >
                Check now
              </button>
              <ComingSoonChip />
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

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
