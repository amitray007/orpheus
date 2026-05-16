import { definePatch, ensureReady } from '@web-kits/audio'
import type { SoundPatch } from '@web-kits/audio'
import coreSoundsJson from '../assets/sounds/core.json'

const coreSounds = coreSoundsJson as SoundPatch

// Build the patch once at module load — definePatch is synchronous.
const patch = definePatch(coreSounds)

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

type SoundName =
  | 'click' | 'tap' | 'key-press' | 'checkbox' | 'radio' | 'tick' | 'scroll-snap'
  | 'focus' | 'blur' | 'toggle-on' | 'toggle-off' | 'hover' | 'select' | 'deselect'
  | 'pop' | 'boop' | 'bounce' | 'spring' | 'expand' | 'collapse' | 'success' | 'complete'
  | 'level-up' | 'confetti' | 'save' | 'ding' | 'notification' | 'mention' | 'badge'
  | 'info' | 'sparkle' | 'star' | 'error' | 'delete' | 'warning' | 'swoosh' | 'whoosh'
  | 'page-enter' | 'page-exit' | 'tab-switch' | 'drawer-open' | 'drawer-close'
  | 'modal-open' | 'modal-close' | 'dropdown-open' | 'dropdown-close' | 'slide'
  | 'slide-up' | 'slide-down' | 'copy' | 'send' | 'receive' | 'command' | 'escape'
  | 'undo' | 'archive' | 'sync' | 'heart' | 'streak' | 'loading-start' | 'loading-end'
  | 'progress-tick'

/**
 * Fire-and-forget sound playback. No-op when disabled. Gracefully swallows
 * AudioContext errors so it's safe to call from any handler.
 */
export function playSound(name: SoundName): void {
  if (!enabled) return
  // Arm the AudioContext on first call — one-time per page lifecycle.
  // The arm() promise runs in the background; we don't await it here.
  void arm()
  try {
    patch.play(name)
  } catch (err) {
    console.warn('[sound] play failed for', name, err)
  }
}
