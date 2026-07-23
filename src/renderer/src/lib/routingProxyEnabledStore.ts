/**
 * Single-value external store for the routing proxy's `enabled` flag —
 * mirrors uiStateStore.ts's pattern exactly (one seed fetch, one push
 * subscription, useSyncExternalStore for every consumer) but scoped to just
 * this one boolean rather than the whole RoutingProxySnapshot, since that's
 * all any consumer of this module needs so far: the "Refresh models" button
 * (RefreshModelsButton.tsx) hides itself when routing is disabled — a
 * Claude-only flyout has only one provider, so a refresh control is
 * pointless there (see that component's own doc comment).
 *
 * Deliberately does NOT reuse selectableModelsStore.ts's own
 * routingProxy:onSnapshot subscription — that module's subscription is
 * scoped to invalidating the model-list cache, gated behind `enabled` fetch
 * flags per caller, and not exported as a general-purpose snapshot reader.
 * This is a second, independent subscription to the SAME push channel
 * (window.api.routingProxy.onSnapshot supports multiple listeners), kept
 * deliberately separate so a change to one module's internals can never
 * accidentally couple to the other's.
 */

import { useSyncExternalStore } from 'react'

let enabled = false
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function setEnabled(next: boolean): void {
  if (next === enabled) return
  enabled = next
  notify()
}

let started = false

function ensureStarted(): void {
  if (started) return
  started = true
  window.api.routingProxy
    .getState()
    .then((snapshot) => setEnabled(snapshot.enabled))
    .catch((err) => {
      console.error('[routingProxyEnabledStore] failed to load initial state', err)
    })
  window.api.routingProxy.onSnapshot((snapshot) => setEnabled(snapshot.enabled))
}

/** Subscribe to whether the routing proxy is currently enabled. Defaults to
 *  `false` until the initial routingProxy:getState() resolves — the safe
 *  default for a visibility gate (a control that's pointless when disabled
 *  should stay hidden during the brief unknown window, not flash visible
 *  then disappear). */
export function useRoutingProxyEnabled(): boolean {
  ensureStarted()
  return useSyncExternalStore(
    subscribe,
    () => enabled,
    () => enabled
  )
}
