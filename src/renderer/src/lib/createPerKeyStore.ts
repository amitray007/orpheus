/**
 * Generic per-key external store factory — the shared Map + per-key-listeners
 * + useSyncExternalStore machinery that {git,pr,title,activity,activityTime}Store
 * each hand-rolled independently. One leaf subscribes to one key; a write to
 * key A never wakes up subscribers of key B.
 *
 * This factory captures ONLY the shape common to all of them: a Map<string, T>,
 * a `set(key, value)` write with a pluggable no-op guard, a `delete(key)`, a
 * read-only snapshot getter, and a `useKey(key)` hook. Callers that need extra
 * behavior (batched writes, multi-key subscriptions, external IPC wiring,
 * non-`set`/`delete` write shapes) compose additional functions around the
 * returned store in their own file — see gitStore.ts / prStore.ts / activityStore.ts
 * for what stays store-specific.
 *
 * Every write ALWAYS checks strict identity (`prev === next`) first and
 * no-ops if it matches — this mirrors every hand-rolled store's own
 * `if (prev === value) return` and matters for values (e.g. `null`) that a
 * custom `equals` wouldn't otherwise catch. Beyond that, two optional guards
 * (evaluated in this order, only reached once identity has NOT matched):
 *   equals    — (prev, next) => boolean. When true, set() is a no-op (no store
 *               mutation, no notify). Use for field-shallow equality on
 *               objects (e.g. GitStatus, GhPullRequest) so a structurally
 *               identical IPC payload with a new object reference doesn't
 *               spuriously notify subscribers.
 *   monotonic — (prev, next) => boolean. When true, the write is ALLOWED to
 *               proceed; when false, set() is a no-op. Used for "only move
 *               forward" semantics (activityTimeStore).
 */

import { useCallback, useSyncExternalStore } from 'react'

export interface PerKeyStoreOptions<T> {
  /** Returns true when `next` should be treated as equal to `prev` (write becomes a no-op). Defaults to `prev === next`. */
  equals?: (prev: T, next: T) => boolean
  /** Returns true when the write from `prev` to `next` is allowed to proceed. Checked after `equals`. Defaults to always-allow. */
  monotonic?: (prev: T, next: T) => boolean
}

export interface PerKeyStore<T> {
  /** Update a single key. No-op per the configured equals/monotonic guards. */
  set: (key: string, value: T) => void
  /** Remove a key's entry (e.g. on archive). No-op if the key is absent. */
  remove: (key: string) => void
  /** Returns a stable snapshot reference of the current store state (no subscription). */
  getSnapshot: () => ReadonlyMap<string, T>
  /**
   * Subscribe to a single key. Components calling this re-render ONLY when
   * that specific key changes, not when any other key's value changes.
   * Returns `undefined` when the key has never been set.
   */
  useKey: (key: string) => T | undefined
  /** Internal: subscribe a raw listener to one key's changes (used by callers that need multi-key composition, e.g. useActiveIdsKey). */
  subscribe: (key: string, fn: () => void) => () => void
  /** Internal: the raw backing Map (used by callers that need direct reads outside React, e.g. getSnapshot callers wanting a typed default). */
  raw: Map<string, T>
}

export function createPerKeyStore<T>(options?: PerKeyStoreOptions<T>): PerKeyStore<T> {
  const equals = options?.equals ?? ((prev: T, next: T) => prev === next)
  const monotonic = options?.monotonic

  const store = new Map<string, T>()
  const listeners = new Map<string, Set<() => void>>()

  function notify(key: string): void {
    listeners.get(key)?.forEach((fn) => fn())
  }

  function subscribe(key: string, fn: () => void): () => void {
    let keyListeners = listeners.get(key)
    if (!keyListeners) {
      keyListeners = new Set()
      listeners.set(key, keyListeners)
    }
    keyListeners.add(fn)
    return () => {
      keyListeners!.delete(fn)
      if (keyListeners!.size === 0) listeners.delete(key)
    }
  }

  function set(key: string, value: T): void {
    const prev = store.get(key)
    // Identity check always runs first (matches every hand-rolled store's
    // `if (prev === value) return`), regardless of a custom `equals` — this
    // matters for reference-or-primitive-equal values (e.g. null === null)
    // that a field-shallow `equals` wouldn't otherwise treat as equal.
    if (prev === value) return
    if (prev !== undefined && equals(prev, value)) return
    if (prev !== undefined && monotonic && !monotonic(prev, value)) return
    store.set(key, value)
    notify(key)
  }

  function remove(key: string): void {
    if (!store.has(key)) return
    store.delete(key)
    notify(key)
  }

  function getSnapshot(): ReadonlyMap<string, T> {
    return store
  }

  function useKey(key: string): T | undefined {
    const subscribeForKey = useCallback((fn: () => void) => subscribe(key, fn), [key])
    return useSyncExternalStore(
      subscribeForKey,
      () => store.get(key),
      () => store.get(key) // server snapshot — same in Electron context
    )
  }

  return { set, remove, getSnapshot, useKey, subscribe, raw: store }
}
