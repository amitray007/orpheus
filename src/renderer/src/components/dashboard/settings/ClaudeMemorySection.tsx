import { useEffect, useState } from 'react'
import type React from 'react'
import type { ClaudeGlobalSettings } from '@shared/types'
import { SettingRow, Toggle, NumberInput } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// ClaudeMemorySection — git instructions, context limits, compaction
// ---------------------------------------------------------------------------

export function ClaudeMemorySection(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((err) => console.error('[memory-settings] load failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<ClaudeGlobalSettings>): void {
    if (!settings) return
    setSettings({ ...settings, ...p })
    window.api.claudeSettings.update(p).catch((err) => {
      console.error('[memory-settings] update failed; refetching', err)
      window.api.claudeSettings
        .get()
        .then((s) => setSettings(s))
        .catch(console.error)
    })
  }

  if (!settings) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Memory &amp; Context</h2>
          <p className="text-xs text-text-muted mt-1">
            Fine-grained control over CLAUDE.md auto-load behavior, context window limits, and
            compaction thresholds.
          </p>
        </div>
        <SettingsSectionSkeleton groups={2} rowsPerGroup={2} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Memory &amp; Context</h2>
        <p className="text-xs text-text-muted mt-1">
          Fine-grained control over CLAUDE.md auto-load behavior, context window limits, and
          compaction thresholds. Changes save automatically.
        </p>
      </div>

      {/* Memory files */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Memory files
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Disable git instructions"
            description="Suppress the automatic git-context message that Claude prepends to sessions."
            mapsTo="CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS"
          >
            <Toggle
              ariaLabel="Disable git instructions"
              value={settings.disableGitInstructions}
              onChange={(v) => patch({ disableGitInstructions: v })}
            />
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
            description="Upper bound on tokens in a single Claude response. Leave empty to use claude's default. Suggested range: 1024–8192."
            mapsTo="CLAUDE_CODE_MAX_OUTPUT_TOKENS"
          >
            <NumberInput
              value={settings.maxOutputTokens}
              onChange={(v) => patch({ maxOutputTokens: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Max context tokens"
            description="Cap on the total context window sent per turn. Leave empty to use the model's max. Suggested range: 8000–200000."
            mapsTo="CLAUDE_CODE_MAX_CONTEXT_TOKENS"
          >
            <NumberInput
              value={settings.maxContextTokens}
              onChange={(v) => patch({ maxContextTokens: v })}
              placeholder="default"
            />
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
            description="Compact older context when usage exceeds this percentage. Leave empty to use claude's default. Typical range: 50–95."
            mapsTo="CLAUDE_CODE_AUTO_COMPACT_THRESHOLD"
          >
            <div className="flex items-center gap-1.5">
              <NumberInput
                value={settings.compactionThreshold}
                onChange={(v) => patch({ compactionThreshold: v })}
                placeholder="default"
                className="w-24 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono text-right cursor-text"
              />
              <span className="text-xs text-text-muted">%</span>
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Token limits & memory */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Token limits &amp; memory
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Max thinking tokens"
            description="Upper bound on tokens used for extended thinking per response (MAX_THINKING_TOKENS). Leave empty to use claude's default."
            mapsTo="MAX_THINKING_TOKENS"
          >
            <NumberInput
              value={settings.maxThinkingTokens}
              onChange={(v) => patch({ maxThinkingTokens: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="File read max output tokens"
            description="Truncation limit for file-read tool output (CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS"
          >
            <NumberInput
              value={settings.fileReadMaxOutputTokens}
              onChange={(v) => patch({ fileReadMaxOutputTokens: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Disable CLAUDE.md memory files"
            description="Prevent Claude from loading CLAUDE.md files from the filesystem (CLAUDE_CODE_DISABLE_CLAUDE_MDS=1)."
            mapsTo="CLAUDE_CODE_DISABLE_CLAUDE_MDS"
          >
            <Toggle
              ariaLabel="Disable CLAUDE.md memory files"
              value={settings.disableClaudeMds}
              onChange={(v) => patch({ disableClaudeMds: v })}
            />
          </SettingRow>
          <SettingRow
            label="Auto-compact context window (tokens)"
            description="Token count at which Claude triggers context auto-compaction (CLAUDE_CODE_AUTO_COMPACT_WINDOW). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_AUTO_COMPACT_WINDOW"
          >
            <NumberInput
              value={settings.autoCompactWindow}
              onChange={(v) => patch({ autoCompactWindow: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Auto-compact percentage override (0–100)"
            description="Override the percentage of context used before auto-compaction triggers (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE). Leave empty to use claude's default."
            mapsTo="CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"
          >
            <div className="flex items-center gap-1.5">
              <NumberInput
                value={settings.autocompactPctOverride}
                onChange={(v) => patch({ autocompactPctOverride: v })}
                placeholder="default"
                className="w-24 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono text-right cursor-text"
              />
              <span className="text-xs text-text-muted">%</span>
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
