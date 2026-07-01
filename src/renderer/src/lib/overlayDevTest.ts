// ---------------------------------------------------------------------------
// src/renderer/src/lib/overlayDevTest.ts
//
// U6 — dev-only harness to exercise the overlay matrix by hand. Cmd+Shift+Alt+O
// cycles through a fixed set of `devTest` descriptors covering the three
// interactivity classes (modal, card, tooltip) plus a hide step, so a human
// can eyeball focus/click/hover/hide behavior without wiring a real caller.
//
// Gated on __ORPHEUS_MODE__ !== 'production' (see env.d.ts) so production
// builds never register the listener; init() is a no-op there. Ships inert
// alongside the `devTest` kind (registry.tsx) which is also dev-only in
// intent, even though nothing currently prevents it from being imported in
// prod (the kind itself is harmless dead code if never shown).
// ---------------------------------------------------------------------------

import type { OverlayDescriptor, OverlayEvent } from '@shared/types'

const LOG_PREFIX = '[overlayDevTest]'

const ANCHOR_RECT = { x: 300, y: 200, w: 200, h: 32 } as const

// Module-level cycle counter + the id of whatever the harness currently has
// on screen (undefined once hidden).
let cycle = 0
let lastShownId: string | undefined

function buildDescriptor(step: number): OverlayDescriptor | null {
  const id = crypto.randomUUID()
  switch (step % 4) {
    case 0:
      // (a) centered modal-class: scrim + card + input, takes focus + clicks.
      return {
        id,
        kind: 'devTest',
        placement: { mode: 'centered' },
        props: { label: 'modal-class (centered)', cycle },
        acceptsClicks: true,
        takesFocus: true
      }
    case 1:
      // (b) anchored card-class: clickable, no focus steal.
      return {
        id,
        kind: 'devTest',
        placement: { mode: 'anchored', anchorRect: ANCHOR_RECT, preferredSide: 'bottom' },
        props: { label: 'card-class (anchored)', cycle },
        acceptsClicks: true,
        takesFocus: false
      }
    case 2:
      // (c) anchored tooltip-class: no clicks, no focus.
      return {
        id,
        kind: 'devTest',
        placement: { mode: 'anchored', anchorRect: ANCHOR_RECT, preferredSide: 'bottom' },
        props: { label: 'tooltip-class (anchored)', cycle },
        acceptsClicks: false,
        takesFocus: false
      }
    default:
      // (d) hide whatever is showing.
      return null
  }
}

async function runStep(): Promise<void> {
  const step = cycle
  cycle += 1

  const descriptor = buildDescriptor(step)

  if (!descriptor) {
    const idToHide = lastShownId
    console.log(`${LOG_PREFIX} hide`, { idToHide })
    if (!idToHide) return
    try {
      await window.api.overlay.hide(idToHide)
      console.log(`${LOG_PREFIX} hide resolved`, { idToHide })
    } catch (err) {
      console.error(`${LOG_PREFIX} hide rejected`, { idToHide, err })
    } finally {
      lastShownId = undefined
    }
    return
  }

  lastShownId = descriptor.id
  console.log(`${LOG_PREFIX} show`, descriptor)
  try {
    const result = await window.api.overlay.show(descriptor)
    console.log(`${LOG_PREFIX} show resolved`, { id: descriptor.id, result })
  } catch (err) {
    console.error(`${LOG_PREFIX} show rejected`, { id: descriptor.id, err })
  }
}

function onKeyDown(e: KeyboardEvent): void {
  // Cmd+Shift+Alt+O
  if (!e.metaKey || !e.shiftKey || !e.altKey || e.key.toLowerCase() !== 'o') return
  e.preventDefault()
  void runStep()
}

/** Cycles the overlay dev-test matrix — same behavior as the Cmd+Shift+Alt+O shortcut. */
export function cycleOverlayDevTest(): void {
  void runStep()
}

function onOverlayEvent(event: OverlayEvent): void {
  console.log(`${LOG_PREFIX} event`, event)
  if (event.overlayId !== lastShownId) return
  if (event.type !== 'cancel' && event.type !== 'clicked') return
  const id = lastShownId
  lastShownId = undefined
  void window.api.overlay
    .hide(id)
    .then(() => console.log(`${LOG_PREFIX} auto-hide resolved`, { id }))
    .catch((err) => console.error(`${LOG_PREFIX} auto-hide rejected`, { id, err }))
}

let initialized = false

/** Registers the dev-only shortcut + overlay event listener. No-op in production (and if called twice). */
export function initOverlayDevTest(): void {
  if (__ORPHEUS_MODE__ === 'production') return
  if (initialized) return
  initialized = true

  window.addEventListener('keydown', onKeyDown)
  window.api.overlay.onEvent(onOverlayEvent)

  console.log(`${LOG_PREFIX} initialized — Cmd+Shift+Alt+O to cycle the overlay matrix`)
}
