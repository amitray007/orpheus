import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// ClaudeMemorySection — CLAUDE.md behavior, context limits, compaction
// ---------------------------------------------------------------------------

export function ClaudeMemorySection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Memory &amp; Context</h2>
        <p className="text-xs text-text-muted mt-1">
          Fine-grained control over CLAUDE.md auto-load behavior, context window limits, and
          compaction thresholds.
        </p>
      </div>

      {/* Memory files */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Memory files
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-load CLAUDE.md"
            description="Automatically include CLAUDE.md context files when Claude starts. Mirrors the General setting."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle checked />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Disable git instructions"
            description="Suppress the automatic git-context message that Claude prepends to sessions."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Token limits */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Token limits
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Max output tokens"
            description="Upper bound on tokens in a single Claude response. Higher = more complete but slower."
          >
            <div className="flex items-center gap-2">
              <input
                disabled
                placeholder="8192"
                className="w-24 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono text-right opacity-50 cursor-not-allowed"
              />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Max context tokens"
            description="Cap on the total context window sent per turn. Reduces cost on large files."
          >
            <div className="flex items-center gap-2">
              <input
                disabled
                placeholder="200000"
                className="w-24 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono text-right opacity-50 cursor-not-allowed"
              />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Compaction */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Compaction
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Compaction threshold"
            description="Percentage of context window used before Claude automatically compacts older turns."
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 opacity-50 pointer-events-none">
                <input
                  disabled
                  placeholder="80"
                  className="w-16 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono text-right cursor-not-allowed"
                />
                <span className="text-xs text-text-muted">%</span>
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
