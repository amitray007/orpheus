import { useEffect, useState } from 'react'
import type React from 'react'
import type {
  ClaudeGlobalSettings,
  ClaudeOutputStyle,
  ClaudeTuiMode,
  ClaudeEditorMode
} from '@shared/types'
import { SettingRow, SegmentedControl, Toggle, NumberInput } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

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
        <SettingsSectionSkeleton groups={2} rowsPerGroup={3} />
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
            mapsTo="outputStyle"
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
            mapsTo="tui"
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
            mapsTo="editorMode"
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
            mapsTo="CLAUDE_CODE_NATIVE_CURSOR"
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
            mapsTo="CLAUDE_CODE_HIDE_CWD"
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
            mapsTo="prefersReducedMotion"
          >
            <Toggle
              ariaLabel="Reduce motion"
              value={settings.reduceMotion}
              onChange={(v) => patch({ reduceMotion: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Rendering */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Rendering
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="No flicker"
            description="Reduce screen flicker on some terminal emulators (CLAUDE_CODE_NO_FLICKER=1)."
            mapsTo="CLAUDE_CODE_NO_FLICKER"
          >
            <Toggle
              ariaLabel="No flicker"
              value={settings.noFlicker}
              onChange={(v) => patch({ noFlicker: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable alternate screen"
            description="Prevent Claude from switching to an alternate terminal screen buffer (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1)."
            mapsTo="CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"
          >
            <Toggle
              ariaLabel="Disable alternate screen"
              value={settings.disableAlternateScreen}
              onChange={(v) => patch({ disableAlternateScreen: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable virtual scroll"
            description="Turn off Claude's virtual scrolling implementation (CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1)."
            mapsTo="CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL"
          >
            <Toggle
              ariaLabel="Disable virtual scroll"
              value={settings.disableVirtualScroll}
              onChange={(v) => patch({ disableVirtualScroll: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable mouse"
            description="Disable mouse event handling inside Claude's terminal UI (CLAUDE_CODE_DISABLE_MOUSE=1)."
            mapsTo="CLAUDE_CODE_DISABLE_MOUSE"
          >
            <Toggle
              ariaLabel="Disable mouse"
              value={settings.disableMouse}
              onChange={(v) => patch({ disableMouse: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable terminal title"
            description="Stop Claude from updating the terminal window title during sessions (CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1)."
            mapsTo="CLAUDE_CODE_DISABLE_TERMINAL_TITLE"
          >
            <Toggle
              ariaLabel="Disable terminal title"
              value={settings.disableTerminalTitle}
              onChange={(v) => patch({ disableTerminalTitle: v })}
            />
          </SettingRow>
          <SettingRow
            label="Scroll speed (1–20)"
            description="Override the scroll speed inside Claude's TUI (CLAUDE_CODE_SCROLL_SPEED). Leave empty to use the default."
            mapsTo="CLAUDE_CODE_SCROLL_SPEED"
          >
            <NumberInput
              value={settings.scrollSpeed}
              onChange={(v) => patch({ scrollSpeed: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Code accessibility"
            description="Enable accessibility enhancements for code blocks in Claude's output (CLAUDE_CODE_CODE_ACCESSIBILITY=1)."
            mapsTo="CLAUDE_CODE_CODE_ACCESSIBILITY"
          >
            <Toggle
              ariaLabel="Code accessibility"
              value={settings.codeAccessibility}
              onChange={(v) => patch({ codeAccessibility: v })}
            />
          </SettingRow>
          <SettingRow
            label="Omit attribution header"
            description="Remove the attribution block from the system prompt start (CLAUDE_CODE_ATTRIBUTION_HEADER=1)."
            mapsTo="CLAUDE_CODE_ATTRIBUTION_HEADER"
          >
            <Toggle
              ariaLabel="Omit attribution header"
              value={settings.omitAttributionHeader}
              onChange={(v) => patch({ omitAttributionHeader: v })}
            />
          </SettingRow>
          <SettingRow
            label="Force sync output"
            description="Force all terminal output to be written synchronously (CLAUDE_CODE_FORCE_SYNC_OUTPUT=1)."
            mapsTo="CLAUDE_CODE_FORCE_SYNC_OUTPUT"
          >
            <Toggle
              ariaLabel="Force sync output"
              value={settings.forceSyncOutput}
              onChange={(v) => patch({ forceSyncOutput: v })}
            />
          </SettingRow>
          <SettingRow
            label="Enable prompt suggestion"
            description="Show inline prompt suggestions inside the Claude input field (CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1)."
            mapsTo="CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION"
          >
            <Toggle
              ariaLabel="Enable prompt suggestion"
              value={settings.enablePromptSuggestion}
              onChange={(v) => patch({ enablePromptSuggestion: v })}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
