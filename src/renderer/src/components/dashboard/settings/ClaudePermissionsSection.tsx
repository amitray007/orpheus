import { useEffect, useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import type { ClaudeGlobalSettings } from '@shared/types'
import { SettingRow, Toggle, RuleListEditor, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// ClaudePermissionsSection — quick toggles + permission rule editor
// ---------------------------------------------------------------------------

export function ClaudePermissionsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((err) => console.error('[permissions-settings] load failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<ClaudeGlobalSettings>): void {
    if (!settings) return
    setSettings({ ...settings, ...p })
    window.api.claudeSettings.update(p).catch((err) => {
      console.error('[permissions-settings] update failed; refetching', err)
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
          <SectionTitle>Permissions</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Quick toggles for everyday safety controls, plus a collapsible rule editor for advanced
            allow/ask/deny policies.
          </p>
        </div>
        <SettingsSectionSkeleton groups={2} rowsPerGroup={3} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Permissions</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Quick toggles for everyday safety controls, plus a collapsible rule editor for advanced
          allow/ask/deny policies. Changes save automatically.{' '}
          <a
            href="https://code.claude.com/docs/en/permissions.md"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            Permission rule syntax
          </a>
          .
        </p>
      </div>

      {/* Quick controls */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Quick controls</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-approve file edits"
            description='Adds "Edit" to the allow list at launch — claude may edit files without prompting.'
            mapsTo="permissions.allow[Edit]"
          >
            <Toggle
              ariaLabel="Auto-approve file edits"
              value={settings.autoApproveEdits}
              onChange={(v) => patch({ autoApproveEdits: v })}
            />
          </SettingRow>
          <SettingRow
            label="Ask before destructive Bash commands"
            description="Injects ask-rules for rm, git reset, force-push, DROP TABLE, and similar at launch."
            mapsTo="permissions.ask[Bash(...)]"
          >
            <Toggle
              ariaLabel="Ask before destructive Bash commands"
              value={settings.askDestructiveBash}
              onChange={(v) => patch({ askDestructiveBash: v })}
            />
          </SettingRow>
          <SettingRow
            label="Plan mode by default"
            description="Sets --permission-mode plan at launch so Claude always produces a plan before executing. Overridden if General's Permission mode is set explicitly."
            mapsTo="--permission-mode plan"
          >
            <Toggle
              ariaLabel="Plan mode by default"
              value={settings.planModeDefault}
              onChange={(v) => patch({ planModeDefault: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Permission rules — collapsible */}
      <section className="flex flex-col">
        <button
          onClick={() => setRulesOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-secondary mb-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded self-start"
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
            <RuleListEditor
              label="Allow rules"
              value={settings.permissionAllowRules}
              onChange={(v) => patch({ permissionAllowRules: v })}
              placeholder="e.g. Bash(npm run *)"
              mapsTo="permissions.allow"
            />
            {/* Ask rules */}
            <RuleListEditor
              label="Ask rules"
              value={settings.permissionAskRules}
              onChange={(v) => patch({ permissionAskRules: v })}
              placeholder="e.g. Bash(git push *)"
              mapsTo="permissions.ask"
            />
            {/* Deny rules */}
            <RuleListEditor
              label="Deny rules"
              value={settings.permissionDenyRules}
              onChange={(v) => patch({ permissionDenyRules: v })}
              placeholder="e.g. Bash(curl *)"
              mapsTo="permissions.deny"
            />
            {/* Additional directories */}
            <RuleListEditor
              label="Additional directories"
              value={settings.permissionAdditionalDirs}
              onChange={(v) => patch({ permissionAdditionalDirs: v })}
              placeholder="e.g. /Users/me/shared"
              mapsTo="permissions.additionalDirectories"
            />
          </div>
        )}
      </section>
    </div>
  )
}
