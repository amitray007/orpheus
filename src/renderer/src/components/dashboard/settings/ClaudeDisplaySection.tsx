import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// ClaudeDisplaySection — output style, TUI renderer, editor mode, a11y toggles
// ---------------------------------------------------------------------------

export function ClaudeDisplaySection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Display</h2>
        <p className="text-xs text-text-muted mt-1">
          Control how Claude renders output, TUI mode, editor keybindings, and accessibility
          preferences.
        </p>
      </div>

      {/* Output behavior */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Output behavior
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Output style"
            description="Influences how verbose and proactive Claude's responses are."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Default', 'Explanatory', 'Proactive', 'Learning'] as const).map((s) => (
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
          <SettingRow
            label="TUI renderer"
            description="Whether Claude's terminal UI fills the pane or stays in a scrollable default view."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Default', 'Fullscreen'] as const).map((s) => (
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

      {/* Editor & input */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Editor &amp; input
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Editor mode"
            description="Keybinding scheme for the Claude Code inline editor."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Normal', 'Vim'] as const).map((s) => (
                  <span
                    key={s}
                    className={[
                      'px-3 py-1.5 text-xs font-medium rounded',
                      s === 'Normal' ? 'bg-accent/15 text-text-primary' : 'text-text-muted'
                    ].join(' ')}
                  >
                    {s}
                  </span>
                ))}
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Native cursor"
            description="Use the system cursor style inside the embedded terminal instead of the block cursor."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Hide cwd in logo"
            description="Remove the current working directory line from Claude's session banner."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Accessibility */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Accessibility
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Reduce motion"
            description="Disables transitions and animations throughout the Orpheus UI."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DisabledToggle — visual-only toggle knob for placeholder rows
// ---------------------------------------------------------------------------

function DisabledToggle(): React.JSX.Element {
  return (
    <div className="relative w-9 h-5 rounded-full bg-surface-overlay border border-border-default pointer-events-none opacity-50">
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm" />
    </div>
  )
}
