import { useEffect, useState } from 'react'
import type React from 'react'
import type {
  ClaudeGlobalSettings,
  ClaudeOutputStyle,
  ClaudeTuiMode,
  ClaudeEditorMode
} from '@shared/types'
import { SettingRow, SegmentedControl, Toggle } from './primitives'

// ---------------------------------------------------------------------------
// ClaudeDisplaySection — output style, TUI renderer, editor mode, a11y toggles
// ---------------------------------------------------------------------------

export function ClaudeDisplaySection(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((err) => console.error('[display-settings] load failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<ClaudeGlobalSettings>): void {
    if (!settings) return
    setSettings({ ...settings, ...p })
    window.api.claudeSettings.update(p).catch((err) => {
      console.error('[display-settings] update failed; refetching', err)
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
          <h2 className="text-base font-semibold text-text-primary">Display</h2>
          <p className="text-xs text-text-muted mt-1">
            Control how Claude renders output, TUI mode, editor keybindings, and accessibility
            preferences.
          </p>
        </div>
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Display</h2>
        <p className="text-xs text-text-muted mt-1">
          Control how Claude renders output, TUI mode, editor keybindings, and accessibility
          preferences. Changes save automatically.
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
            <SegmentedControl<ClaudeOutputStyle>
              ariaLabel="Output style"
              options={[
                { value: 'default', label: 'Default' },
                { value: 'explanatory', label: 'Explanatory' },
                { value: 'proactive', label: 'Proactive' },
                { value: 'learning', label: 'Learning' }
              ]}
              value={settings.outputStyle}
              onChange={(v) => patch({ outputStyle: v })}
            />
          </SettingRow>
          <SettingRow
            label="TUI renderer"
            description="Whether Claude's terminal UI fills the pane or stays in a scrollable default view."
          >
            <SegmentedControl<ClaudeTuiMode>
              ariaLabel="TUI renderer"
              options={[
                { value: 'default', label: 'Default' },
                { value: 'fullscreen', label: 'Fullscreen' }
              ]}
              value={settings.tuiMode}
              onChange={(v) => patch({ tuiMode: v })}
            />
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
            <SegmentedControl<ClaudeEditorMode>
              ariaLabel="Editor mode"
              options={[
                { value: 'normal', label: 'Normal' },
                { value: 'vim', label: 'Vim' }
              ]}
              value={settings.editorMode}
              onChange={(v) => patch({ editorMode: v })}
            />
          </SettingRow>
          <SettingRow
            label="Native cursor"
            description="Use the system cursor style inside the embedded terminal instead of the block cursor."
          >
            <Toggle
              ariaLabel="Native cursor"
              value={settings.nativeCursor}
              onChange={(v) => patch({ nativeCursor: v })}
            />
          </SettingRow>
          <SettingRow
            label="Hide cwd in logo"
            description="Remove the current working directory line from Claude's session banner."
          >
            <Toggle
              ariaLabel="Hide cwd in logo"
              value={settings.hideCwd}
              onChange={(v) => patch({ hideCwd: v })}
            />
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
            <Toggle
              ariaLabel="Reduce motion"
              value={settings.reduceMotion}
              onChange={(v) => patch({ reduceMotion: v })}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
