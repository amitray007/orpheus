import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// OrpheusSidebarSection — sidebar visibility and behavior controls
// ---------------------------------------------------------------------------

export function OrpheusSidebarSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Sidebar</h2>
        <p className="text-xs text-text-muted mt-1">
          Control sidebar sections, workspace counts, and default expand behavior for new projects.
        </p>
      </div>

      {/* Visibility */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Sections
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Pinned section visible"
            description="Show or hide the Pinned workspaces section at the top of the sidebar."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle checked />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Show workspace count inline"
            description="Display a badge with the number of workspaces next to each project name."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle checked />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Expand behavior */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Expand behavior
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Default expand state for new projects"
            description="Whether newly added projects start expanded or collapsed in the sidebar."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Expanded', 'Collapsed'] as const).map((s) => (
                  <span
                    key={s}
                    className={[
                      'px-3 py-1.5 text-xs font-medium rounded',
                      s === 'Expanded' ? 'bg-accent/15 text-text-primary' : 'text-text-muted'
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

      {/* Interaction */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Interaction
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Hover to reveal controls"
            description="Show workspace action buttons (archive, rename, pin) only on hover rather than always visible."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle checked />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Sidebar width"
            description="Drag-to-resize the sidebar. This setting saves the last-used width across restarts."
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 opacity-50 pointer-events-none">
                <input
                  disabled
                  placeholder="224"
                  className="w-16 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono text-right cursor-not-allowed"
                />
                <span className="text-xs text-text-muted">px</span>
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
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
