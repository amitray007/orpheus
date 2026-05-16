import { definePatch, ensureReady } from '@web-kits/audio'
import type { SoundPatch, AudioPatch } from '@web-kits/audio'
import type { SoundPack } from '@shared/types'
import coreSoundsJson from '../assets/sounds/core.json'
import minimalSoundsJson from '../assets/sounds/minimal.json'
import mechanicalSoundsJson from '../assets/sounds/mechanical.json'
import retroSoundsJson from '../assets/sounds/retro.json'
import playfulSoundsJson from '../assets/sounds/playful.json'
import crispSoundsJson from '../assets/sounds/crisp.json'
import organicSoundsJson from '../assets/sounds/organic.json'
import softSoundsJson from '../assets/sounds/soft.json'

// All 8 packs loaded statically so Vite bundles them into the renderer asset
// graph at build time. Each pack is ~7-22 KB.
const PACKS: Record<SoundPack, SoundPatch> = {
  core: coreSoundsJson as SoundPatch,
  minimal: minimalSoundsJson as SoundPatch,
  mechanical: mechanicalSoundsJson as SoundPatch,
  retro: retroSoundsJson as SoundPatch,
  playful: playfulSoundsJson as SoundPatch,
  crisp: crispSoundsJson as SoundPatch,
  organic: organicSoundsJson as SoundPatch,
  soft: softSoundsJson as SoundPatch
}

// Build all patches once at module load — definePatch is synchronous and cheap.
const BUILT_PATCHES: Record<SoundPack, AudioPatch> = {
  core: definePatch(PACKS.core),
  minimal: definePatch(PACKS.minimal),
  mechanical: definePatch(PACKS.mechanical),
  retro: definePatch(PACKS.retro),
  playful: definePatch(PACKS.playful),
  crisp: definePatch(PACKS.crisp),
  organic: definePatch(PACKS.organic),
  soft: definePatch(PACKS.soft)
}

// Active patch — starts with core; swapped by setSoundPack().
let activePatch: AudioPatch = BUILT_PATCHES.core

// AudioContext must be resumed after a user gesture (Chromium autoplay policy).
// We track whether we've armed the context and retry lazily.
let armed = false

async function arm(): Promise<void> {
  if (armed) return
  try {
    await ensureReady()
    armed = true
  } catch {
    // AudioContext locked — will retry on the next playSound call
  }
}

// Master enable flag — controlled by the playInteractionSounds uiState field.
// Default true so sounds play from the first render (before uiState loads).
let enabled = true

/** Update the enabled state from uiState.playInteractionSounds. */
export function setSoundEnabled(v: boolean): void {
  enabled = v
}

/** Swap the active sound pack. Re-arms the AudioContext if not yet armed. */
export function setSoundPack(packName: SoundPack): void {
  const next = BUILT_PATCHES[packName]
  if (next) {
    activePatch = next
    // Re-arm in case the context was lost
    armed = false
  }
}

type SoundName =
  | 'click'
  | 'tap'
  | 'key-press'
  | 'checkbox'
  | 'radio'
  | 'tick'
  | 'scroll-snap'
  | 'focus'
  | 'blur'
  | 'toggle-on'
  | 'toggle-off'
  | 'hover'
  | 'select'
  | 'deselect'
  | 'pop'
  | 'boop'
  | 'bounce'
  | 'spring'
  | 'expand'
  | 'collapse'
  | 'success'
  | 'complete'
  | 'level-up'
  | 'confetti'
  | 'save'
  | 'ding'
  | 'notification'
  | 'mention'
  | 'badge'
  | 'info'
  | 'sparkle'
  | 'star'
  | 'error'
  | 'delete'
  | 'warning'
  | 'swoosh'
  | 'whoosh'
  | 'page-enter'
  | 'page-exit'
  | 'tab-switch'
  | 'drawer-open'
  | 'drawer-close'
  | 'modal-open'
  | 'modal-close'
  | 'dropdown-open'
  | 'dropdown-close'
  | 'slide'
  | 'slide-up'
  | 'slide-down'
  | 'copy'
  | 'send'
  | 'receive'
  | 'command'
  | 'escape'
  | 'undo'
  | 'archive'
  | 'sync'
  | 'heart'
  | 'streak'
  | 'loading-start'
  | 'loading-end'
  | 'progress-tick'

/**
 * Fire-and-forget sound playback. No-op when disabled or when the active pack
 * doesn't include the named sound (gracefully falls through). Safe to call from
 * any handler.
 */
export function playSound(name: SoundName): void {
  if (!enabled) return
  // Arm the AudioContext on first call — one-time per page lifecycle.
  // The arm() promise runs in the background; we don't await it here.
  void arm()
  // Guard: if the active pack doesn't have this sound, skip silently.
  // This avoids a noisy console warning when themed packs (26 sounds) are
  // selected and a core-only sound (e.g. 'ding', 'drawer-open') fires.
  if (!activePatch.get(name)) return
  try {
    activePatch.play(name)
  } catch (err) {
    console.warn('[sound] play failed for', name, err)
  }
}
