import { useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// ClaudePermissionsSection — quick toggles + permission rule editor (placeholder)
// ---------------------------------------------------------------------------

export function ClaudePermissionsSection(): React.JSX.Element {
  const [rulesOpen, setRulesOpen] = useState(false)

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Permissions</h2>
        <p className="text-xs text-text-muted mt-1">
          Quick toggles for everyday safety controls, plus a collapsible rule editor for advanced
          allow/ask/deny policies.
        </p>
      </div>

      {/* Quick controls */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Quick controls
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-approve file edits in workspace"
            description="Skip the permission prompt for every file write or patch in the current project."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Ask before destructive Bash commands"
            description="Pause and confirm before rm, git reset --hard, DROP TABLE, and similar."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Plan mode by default"
            description="Claude will always produce a plan and wait for approval before executing."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Permission rules (collapsible) */}
      <section className="flex flex-col">
        <button
          onClick={() => setRulesOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-secondary mb-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
        >
          {rulesOpen ? (
            <CaretDown size={12} weight="bold" />
          ) : (
            <CaretRight size={12} weight="bold" />
          )}
          Permission rules
        </button>

        {rulesOpen && (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4 flex flex-col gap-6">
            {/* Allow rules */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-text-primary">Allow rules</span>
                <ComingSoonChip />
              </div>
              <div className="rounded-md border border-border-default/50 bg-surface-overlay px-4 py-3">
                <p className="text-xs text-text-muted italic">
                  Rule editor coming soon — patterns that Claude may execute without prompting.
                </p>
              </div>
            </div>
            {/* Ask rules */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-text-primary">Ask rules</span>
                <ComingSoonChip />
              </div>
              <div className="rounded-md border border-border-default/50 bg-surface-overlay px-4 py-3">
                <p className="text-xs text-text-muted italic">
                  Rule editor coming soon — patterns that always require user confirmation.
                </p>
              </div>
            </div>
            {/* Deny rules */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-text-primary">Deny rules</span>
                <ComingSoonChip />
              </div>
              <div className="rounded-md border border-border-default/50 bg-surface-overlay px-4 py-3">
                <p className="text-xs text-text-muted italic">
                  Rule editor coming soon — patterns that Claude will always refuse to execute.
                </p>
              </div>
            </div>
            {/* Additional directories */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-text-primary">
                  Additional directories
                </span>
                <ComingSoonChip />
              </div>
              <div className="rounded-md border border-border-default/50 bg-surface-overlay px-4 py-3">
                <p className="text-xs text-text-muted italic">
                  Directory allowlist coming soon — grant Claude access to paths outside the
                  workspace root.
                </p>
              </div>
            </div>
          </div>
        )}
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
