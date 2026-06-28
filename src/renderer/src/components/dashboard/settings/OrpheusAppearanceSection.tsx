import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState, Theme, AccentColor, UiFontScale, SoundPack } from '@shared/types'
import { SettingRow, Toggle, Select, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { playSound, setSoundPack } from '../../../lib/sound'

// ---------------------------------------------------------------------------
// OrpheusAppearanceSection — theme, accent color, font size, sound
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'midnight', label: 'Midnight' },
  { value: 'daylight', label: 'Daylight' },
  { value: 'eclipse', label: 'Eclipse' }
]

const ACCENT_COLORS: { value: AccentColor; label: string; hex: string }[] = [
  { value: 'gold', label: 'Gold', hex: '#d4a847' },
  { value: 'blue', label: 'Blue', hex: '#3b8eff' },
  { value: 'teal', label: 'Teal', hex: '#2cc3a8' },
  { value: 'orange', label: 'Orange', hex: '#ff8c42' },
  { value: 'pink', label: 'Pink', hex: '#ff5fa0' }
]

// Theme-default accents for the "no explicit pick" active-state indicator
const THEME_DEFAULT_ACCENT: Record<Theme, string> = {
  midnight: '#d4a847',
  daylight: '#b8902f',
  eclipse: '#e8c060'
}

const FONT_SCALE_OPTIONS: { value: UiFontScale; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' }
]

const SOUND_PACK_OPTIONS: { value: SoundPack; label: string }[] = [
  { value: 'core', label: 'Core' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'mechanical', label: 'Mechanical' },
  { value: 'retro', label: 'Retro' },
  { value: 'playful', label: 'Playful' },
  { value: 'crisp', label: 'Crisp' },
  { value: 'organic', label: 'Organic' },
  { value: 'soft', label: 'Soft' }
]

export function OrpheusAppearanceSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.uiState
      .get()
      .then((s) => {
        if (!cancelled) setUiState(s)
      })
      .catch((err) => {
        console.error('[settings] failed to load uiState', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<AppUiState>): void {
    if (!uiState) return
    const next = { ...uiState, ...p }
    setUiState(next)

    // Apply to document root immediately so theme/accent/scale switches feel
    // instant. Dashboard.tsx also applies on its own uiState load (for the
    // mount-time / cross-launch case) — both writers stay in sync.
    const root = document.documentElement
    // eslint-disable-next-line react-hooks/immutability -- mutating DOM dataset, not React state
    if ('theme' in p && next.theme) root.dataset.theme = next.theme
    if ('accentColor' in p) {
      // eslint-disable-next-line react-hooks/immutability -- mutating DOM dataset, not React state
      if (next.accentColor) root.dataset.accent = next.accentColor
      // eslint-disable-next-line react-hooks/immutability -- mutating DOM dataset, not React state
      else delete root.dataset.accent
    }
    // eslint-disable-next-line react-hooks/immutability -- mutating DOM dataset, not React state
    if ('uiFontScale' in p && next.uiFontScale) root.dataset.fontScale = next.uiFontScale

    window.api.uiState.update(p).catch((err) => {
      console.error('[settings] uiState update failed; refetching to reconcile', err)
      window.api.uiState
        .get()
        .then((s) => setUiState(s))
        .catch(console.error)
    })
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Appearance</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Theme, accent color, and font size scale for the Orpheus UI.
          </p>
        </div>
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
      </div>
    )
  }

  if (!uiState) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Appearance</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Theme, accent color, and font size scale for the Orpheus UI.
          </p>
        </div>
        <SettingsSectionSkeleton groups={4} rowsPerGroup={1} />
      </div>
    )
  }

  const currentTheme = uiState.theme ?? 'midnight'
  const currentAccent = uiState.accentColor ?? null
  const currentScale = uiState.uiFontScale ?? 'default'

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Appearance</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Theme, accent color, and font size scale for the Orpheus UI.
        </p>
      </div>

      {/* Theme */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Theme</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Color theme"
            description="Choose between Midnight (dark), Daylight (warm light), and Eclipse (AMOLED pure black)."
          >
            <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    playSound('swoosh')
                    patch({ theme: opt.value })
                  }}
                  className={[
                    'px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer',
                    opt.value === currentTheme
                      ? 'bg-accent/15 text-text-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Accent color */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Accent color</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Accent"
            description="Used for active states, highlights, and interactive elements. Overrides the theme's default accent. Reset to restore the theme default."
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                {ACCENT_COLORS.map((c) => {
                  // Active when: user explicitly picked this color, OR no
                  // explicit pick and this swatch matches the theme default.
                  const isActive = currentAccent
                    ? currentAccent === c.value
                    : c.hex.toLowerCase() === THEME_DEFAULT_ACCENT[currentTheme].toLowerCase()
                  return (
                    <button
                      key={c.value}
                      type="button"
                      title={c.label}
                      aria-label={c.label}
                      onClick={() => {
                        playSound('tick')
                        patch({ accentColor: c.value })
                      }}
                      className={[
                        'w-6 h-6 rounded-full border-2 transition-all cursor-pointer',
                        'hover:scale-110 focus:outline-none focus:ring-2 focus:ring-white/30 focus:ring-offset-1 focus:ring-offset-transparent',
                        isActive ? 'border-white/70 scale-110' : 'border-transparent'
                      ].join(' ')}
                      style={{ backgroundColor: c.hex }}
                    />
                  )
                })}
              </div>
              {/* Reset to theme default */}
              {currentAccent !== null && (
                <button
                  type="button"
                  title="Reset to theme default"
                  onClick={() => {
                    playSound('tick')
                    patch({ accentColor: null })
                  }}
                  className="ml-1 text-xs text-text-muted hover:text-text-secondary border border-border-default rounded px-1.5 py-0.5 transition-colors cursor-pointer leading-tight"
                >
                  Reset
                </button>
              )}
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Font size */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Typography</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="UI font size scale"
            description="Scales rem-based text in the Orpheus chrome (sidebar, settings, panels). Does not affect the terminal. Arbitrary-px spots (e.g. badge labels) are unaffected."
          >
            <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5">
              {FONT_SCALE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    playSound('tick')
                    patch({ uiFontScale: opt.value })
                  }}
                  className={[
                    'px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer',
                    opt.value === currentScale
                      ? 'bg-accent/15 text-text-primary'
                      : 'text-text-muted hover:text-text-secondary'
                  ].join(' ')}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Sound */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Sound</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Interaction sounds"
            description="Subtle audio feedback for clicks, toggles, modals, and Claude activity transitions."
          >
            <Toggle
              value={uiState.playInteractionSounds ?? true}
              onChange={(v) => patch({ playInteractionSounds: v })}
              ariaLabel="Enable interaction sounds"
            />
          </SettingRow>
          <SettingRow
            label="Sound pack"
            description="Each pack has a different sonic character. Core is the most complete (62 sounds); themed packs have 26 focused on common interactions."
          >
            <Select
              options={SOUND_PACK_OPTIONS}
              value={(uiState.soundPack ?? 'core') as SoundPack}
              onChange={(v) => {
                patch({ soundPack: v })
                setSoundPack(v)
                playSound('toggle-on')
              }}
              ariaLabel="Sound pack"
              className="w-36"
            />
          </SettingRow>
        </div>
      </section>

      {/* Privacy */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Privacy</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="GitHub avatars"
            description="Fetch profile pictures from GitHub for projects whose origin remote is on github.com. Disable to use identicons for all projects."
          >
            <button
              type="button"
              role="switch"
              aria-label="Fetch GitHub avatars"
              aria-checked={uiState.fetchGithubAvatars ?? true}
              onClick={() => patch({ fetchGithubAvatars: !(uiState.fetchGithubAvatars ?? true) })}
              className={[
                'relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                (uiState.fetchGithubAvatars ?? true)
                  ? 'bg-accent'
                  : 'bg-surface-overlay border border-border-default'
              ].join(' ')}
            >
              <span
                className={[
                  'pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
                  (uiState.fetchGithubAvatars ?? true) ? 'translate-x-4' : 'translate-x-0'
                ].join(' ')}
              />
            </button>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
