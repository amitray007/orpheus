import { useEffect, useState } from 'react'
import type React from 'react'
import type { GhosttyUserConfig } from '@shared/types'
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
}

function TextInput({ value, onChange, placeholder, className }: TextInputProps): React.JSX.Element {
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
    </div>
  )
}
