import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { GhosttyKeybind, GhosttyUserConfig } from '@shared/types'
import { SettingRow, Toggle, Select, NumberInput, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// TextInput — local inline text field for ghostty string settings
// ---------------------------------------------------------------------------

interface TextInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  ariaLabel?: string
}

function TextInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel
}: TextInputProps): React.JSX.Element {
  const [local, setLocal] = useState(value)
  const [hasFocus, setHasFocus] = useState(false)

  const displayValue = hasFocus ? local : value

  function handleFocus(): void {
    setHasFocus(true)
    setLocal(value)
  }

  function handleBlur(): void {
    setHasFocus(false)
    const trimmed = local.trim()
    onChange(trimmed)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  return (
    <input
      type="text"
      aria-label={ariaLabel}
      value={displayValue}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={
        className ??
        'w-40 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 cursor-text'
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURSOR_STYLE_OPTIONS = [
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' }
] as const

const KEY_NAMES: Record<string, string> = {
  Enter: 'enter',
  Return: 'enter',
  Backspace: 'backspace',
  Delete: 'backspace',
  Escape: 'escape',
  Tab: 'tab',
  ' ': 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'page_up',
  PageDown: 'page_down',
  F1: 'f1',
  F2: 'f2',
  F3: 'f3',
  F4: 'f4',
  F5: 'f5',
  F6: 'f6',
  F7: 'f7',
  F8: 'f8',
  F9: 'f9',
  F10: 'f10',
  F11: 'f11',
  F12: 'f12'
}

const ACTION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Select action…' },
  { value: 'copy_to_clipboard', label: 'Copy to clipboard' },
  { value: 'paste_from_clipboard', label: 'Paste from clipboard' },
  { value: 'select_all', label: 'Select all' },
  { value: 'clear_screen', label: 'Clear screen' },
  { value: 'scroll_to_top', label: 'Scroll to top' },
  { value: 'scroll_to_bottom', label: 'Scroll to bottom' },
  { value: 'scroll_page_up', label: 'Scroll page up' },
  { value: 'scroll_page_down', label: 'Scroll page down' },
  { value: 'increase_font_size:1', label: 'Increase font size' },
  { value: 'decrease_font_size:1', label: 'Decrease font size' },
  { value: 'reset_font_size', label: 'Reset font size' },
  { value: 'new_split:right', label: 'New split (right)' },
  { value: 'new_split:down', label: 'New split (down)' },
  { value: 'goto_split:next', label: 'Go to next split' },
  { value: 'goto_split:previous', label: 'Go to previous split' },
  { value: 'toggle_split_zoom', label: 'Toggle split zoom' },
  { value: 'ignore', label: 'Ignore (disable key)' },
  { value: 'unbind', label: 'Unbind (remove default)' },
  { value: '__raw__', label: 'Advanced (raw)…' }
]

// ---------------------------------------------------------------------------
// KeyRecorder — captures a key combination for use as a ghostty keybind trigger
// ---------------------------------------------------------------------------

interface KeyRecorderProps {
  value: string
  onChange: (trigger: string) => void
}

function KeyRecorder({ value, onChange }: KeyRecorderProps): React.JSX.Element {
  const [recording, setRecording] = useState(false)
  const divRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (recording) {
      divRef.current?.focus()
    }
  }, [recording])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    e.preventDefault()
    e.stopPropagation()
    const key = e.key
    if (key === 'Meta' || key === 'Control' || key === 'Alt' || key === 'Shift') return
    const parts: string[] = []
    if (e.metaKey) parts.push('super')
    if (e.ctrlKey) parts.push('ctrl')
    if (e.altKey) parts.push('alt')
    if (e.shiftKey) parts.push('shift')
    const keyName = KEY_NAMES[key] ?? key.toLowerCase()
    parts.push(keyName)
    const trigger = parts.join('+')
    setRecording(false)
    onChange(trigger)
  }

  function handleTextChange(e: React.ChangeEvent<HTMLInputElement>): void {
    onChange(e.target.value)
  }

  return (
    <div className="flex items-center gap-2">
      {recording ? (
        <div
          ref={divRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onBlur={() => setRecording(false)}
          className="px-3 py-1.5 rounded-md text-xs bg-accent/10 border border-accent text-accent cursor-default select-none min-w-[100px] text-center outline-none"
        >
          Press a key…
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRecording(true)}
          className="px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-secondary hover:bg-surface-raised"
        >
          Record
        </button>
      )}
      <input
        type="text"
        aria-label="Keybind trigger"
        value={value}
        onChange={handleTextChange}
        placeholder="e.g. ctrl+a"
        className="w-40 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 cursor-text font-mono"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// validateKeybind — returns an error string or null
// ---------------------------------------------------------------------------

function validateKeybind(kb: GhosttyKeybind): string | null {
  if (!kb.trigger.trim()) return 'Trigger is required'
  const chords = kb.trigger.split('>')
  for (const chord of chords) {
    const parts = chord.trim().split('+')
    if (parts.length === 0 || parts[parts.length - 1].trim() === '') {
      return 'Trigger must end with a key'
    }
    const VALID_MODIFIERS = new Set(['super', 'ctrl', 'alt', 'shift'])
    const mods = parts.slice(0, -1)
    for (const mod of mods) {
      if (!VALID_MODIFIERS.has(mod.trim().toLowerCase())) {
        return `Unknown modifier: ${mod}`
      }
    }
  }
  if (!kb.action.trim()) return 'Action is required'
  return null
}

// ---------------------------------------------------------------------------
// OrpheusTerminalSection — ghostty terminal settings
// ---------------------------------------------------------------------------

export function OrpheusTerminalSection(): React.JSX.Element {
  const [config, setConfig] = useState<GhosttyUserConfig | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.ghosttySettings
      .get()
      .then((c) => {
        if (!cancelled) setConfig(c)
      })
      .catch((err) => {
        console.error('[settings] failed to load ghosttySettings', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function patchSettings(partial: Record<string, string | number | boolean>): void {
    if (!config) return
    const nextSettings = { ...config.settings, ...partial }
    for (const [k, v] of Object.entries(nextSettings)) {
      if (v === '') delete nextSettings[k]
    }
    const next: GhosttyUserConfig = { settings: nextSettings, keybinds: config.keybinds }
    setConfig(next)
    window.api.ghosttySettings
      .update({ settings: nextSettings, keybinds: config.keybinds })
      .catch((err) => {
        console.error('[settings] ghosttySettings update failed; refetching', err)
        window.api.ghosttySettings
          .get()
          .then((c) => setConfig(c))
          .catch(console.error)
      })
  }

  function patchKeybinds(nextKeybinds: GhosttyKeybind[]): void {
    if (!config) return
    const next: GhosttyUserConfig = { settings: config.settings, keybinds: nextKeybinds }
    setConfig(next)
    window.api.ghosttySettings
      .update({ settings: config.settings, keybinds: nextKeybinds })
      .catch((err) => {
        console.error('[settings] ghosttySettings update failed; refetching', err)
        window.api.ghosttySettings
          .get()
          .then((c) => setConfig(c))
          .catch(console.error)
      })
  }

  const [kbTrigger, setKbTrigger] = useState('')
  const [kbActionSelect, setKbActionSelect] = useState('')
  const [kbRawAction, setKbRawAction] = useState('')
  const [kbError, setKbError] = useState<string | null>(null)
  const [kbShowEditor, setKbShowEditor] = useState(false)

  function handleSaveKeybind(): void {
    if (kbActionSelect === '__raw__' && !kbRawAction.trim()) {
      setKbError('Enter a raw action')
      return
    }
    const action =
      kbActionSelect === '__raw__' && kbRawAction.trim() ? kbRawAction.trim() : kbActionSelect
    const kb: GhosttyKeybind = { trigger: kbTrigger, action }
    const err = validateKeybind(kb)
    if (err) {
      setKbError(err)
      return
    }
    patchKeybinds([...(config?.keybinds ?? []), kb])
    setKbTrigger('')
    setKbActionSelect('')
    setKbRawAction('')
    setKbError(null)
    setKbShowEditor(false)
  }

  function handleCancelKeybind(): void {
    setKbTrigger('')
    setKbActionSelect('')
    setKbRawAction('')
    setKbError(null)
    setKbShowEditor(false)
  }

  function handleRemoveKeybind(index: number): void {
    if (!config) return
    const next = config.keybinds.filter((_kb, i) => i !== index)
    patchKeybinds(next)
  }

  const header = (
    <div>
      <SectionTitle>Terminal</SectionTitle>
      <p className="text-xs text-text-muted mt-1">
        Configures the embedded Ghostty terminal. Most changes apply immediately to open workspaces;
        font changes may require restarting a workspace.
      </p>
    </div>
  )

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        {header}
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
      </div>
    )
  }

  if (!config) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        {header}
        <SettingsSectionSkeleton groups={4} rowsPerGroup={2} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      {header}

      {/* Font */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Font</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow label="Font family" mapsTo="font-family">
            <TextInput
              value={String(config.settings['font-family'] ?? '')}
              onChange={(v) => patchSettings({ 'font-family': v })}
              placeholder="System monospace"
            />
          </SettingRow>
          <SettingRow label="Font size" mapsTo="font-size">
            <NumberInput
              value={
                config.settings['font-size'] !== undefined
                  ? Number(config.settings['font-size'])
                  : null
              }
              onChange={(v) => {
                if (v === null) patchSettings({ 'font-size': '' })
                else patchSettings({ 'font-size': v })
              }}
              placeholder="13"
            />
          </SettingRow>
        </div>
      </section>

      {/* Theme & Colors */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Theme &amp; Colors</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow label="Theme" mapsTo="theme">
            <TextInput
              value={String(config.settings['theme'] ?? '')}
              onChange={(v) => patchSettings({ theme: v })}
              placeholder="(none)"
            />
          </SettingRow>
          <SettingRow label="Background color" mapsTo="background">
            <TextInput
              value={String(config.settings['background'] ?? '')}
              onChange={(v) => patchSettings({ background: v })}
              placeholder="#282c34"
            />
          </SettingRow>
          <SettingRow label="Foreground color" mapsTo="foreground">
            <TextInput
              value={String(config.settings['foreground'] ?? '')}
              onChange={(v) => patchSettings({ foreground: v })}
              placeholder="#abb2bf"
            />
          </SettingRow>
        </div>
      </section>

      {/* Cursor */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Cursor</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow label="Cursor style" mapsTo="cursor-style">
            <Select
              options={CURSOR_STYLE_OPTIONS}
              value={(config.settings['cursor-style'] as string) ?? 'block'}
              onChange={(v) => patchSettings({ 'cursor-style': v })}
              ariaLabel="Cursor style"
              className="w-36"
            />
          </SettingRow>
          <SettingRow label="Cursor blink" mapsTo="cursor-style-blink">
            <Toggle
              value={
                config.settings['cursor-style-blink'] === true ||
                config.settings['cursor-style-blink'] === 'true'
              }
              onChange={(v) => patchSettings({ 'cursor-style-blink': v })}
              ariaLabel="Cursor blink"
            />
          </SettingRow>
        </div>
      </section>

      {/* Behavior */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Behavior</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow label="Copy on select" mapsTo="copy-on-select">
            <Toggle
              value={
                config.settings['copy-on-select'] !== false &&
                config.settings['copy-on-select'] !== 'false'
              }
              onChange={(v) => patchSettings({ 'copy-on-select': v })}
              ariaLabel="Copy on select"
            />
          </SettingRow>
          <SettingRow
            label="Hide mouse while typing"
            mapsTo="mouse-hide-while-typing"
            description="On by default in Orpheus. Mouse reappears on movement."
          >
            <Toggle
              value={
                config.settings['mouse-hide-while-typing'] !== false &&
                config.settings['mouse-hide-while-typing'] !== 'false'
              }
              onChange={(v) => patchSettings({ 'mouse-hide-while-typing': v })}
              ariaLabel="Hide mouse while typing"
            />
          </SettingRow>
        </div>
      </section>

      {/* Keybindings */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Keybindings</Eyebrow>
        <div className="flex flex-col gap-3">
          {config.keybinds.length === 0 && !kbShowEditor && (
            <p className="text-xs text-text-muted">No custom keybindings.</p>
          )}
          {config.keybinds.map((kb, i) => (
            <div
              key={`${kb.trigger}-${kb.action}-${i}`}
              className="flex items-center gap-3 bg-surface-raised border border-border-default rounded-lg px-4 py-2.5"
            >
              <span className="bg-surface-overlay border border-border-default rounded px-2 py-0.5 font-mono text-xs text-text-primary shrink-0">
                {kb.trigger}
              </span>
              <span className="text-xs text-text-muted">→</span>
              <span className="text-xs text-text-primary flex-1 min-w-0 truncate">{kb.action}</span>
              <button
                type="button"
                onClick={() => handleRemoveKeybind(i)}
                className="text-text-muted hover:text-red-400 text-sm leading-none shrink-0 px-1"
                aria-label="Remove keybinding"
              >
                ×
              </button>
            </div>
          ))}
          {kbShowEditor && (
            <div className="flex flex-col gap-3 bg-surface-raised border border-border-default rounded-lg px-4 py-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-text-muted font-medium">Trigger</span>
                <KeyRecorder value={kbTrigger} onChange={setKbTrigger} />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-text-muted font-medium">Action</span>
                <Select
                  options={ACTION_OPTIONS}
                  value={kbActionSelect}
                  onChange={setKbActionSelect}
                  ariaLabel="Keybind action"
                  className="w-56"
                />
                {kbActionSelect === '__raw__' && (
                  <input
                    type="text"
                    aria-label="Raw keybind action"
                    value={kbRawAction}
                    onChange={(e) => setKbRawAction(e.target.value)}
                    placeholder="e.g. write_scrollback_file:/tmp/buf.txt"
                    className="w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 cursor-text font-mono"
                  />
                )}
              </div>
              {kbError && <p className="text-red-400 text-xs">{kbError}</p>}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleSaveKeybind}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-white hover:bg-accent/90"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={handleCancelKeybind}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-overlay border border-border-default text-text-secondary hover:bg-surface-raised"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!kbShowEditor && (
            <button
              type="button"
              onClick={() => setKbShowEditor(true)}
              className="self-start px-3 py-1.5 rounded-md text-xs font-medium bg-surface-overlay border border-border-default text-text-secondary hover:bg-surface-raised"
            >
              + Add keybinding
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
