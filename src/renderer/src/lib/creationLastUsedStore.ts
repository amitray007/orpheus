// ---------------------------------------------------------------------------
// src/renderer/src/lib/creationLastUsedStore.ts
//
// Session-scoped (in-memory, not DB-persisted) module-level store for the
// workspace-creation popover's "last used" state — see
// creationProviderMenu.ts for the pure state-transition logic this wraps.
// Deliberately NOT persisted across app restarts: it's a same-session
// convenience (the popover reopening mid-session should remember what you
// just picked), not a durable per-user setting, so it doesn't need a new
// app_ui_state column/migration. Every workspace's actual chosen model IS
// durably persisted, via workspace:setModel — this store only remembers
// which provider/model to PRE-SELECT next time the popover opens.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from 'react'
import {
  emptyCreationLastUsedState,
  recordCreationPick,
  type CreationLastUsedState
} from './creationProviderMenu'

let state: CreationLastUsedState = emptyCreationLastUsedState()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

/** Record that `modelId` (belonging to `providerId`) was just picked as the
 *  create-time selection — updates both the per-provider and overall
 *  last-used memory for the NEXT time the popover opens. */
export function recordCreationLastUsed(providerId: string, modelId: string): void {
  state = recordCreationPick(state, providerId, modelId)
  notify()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function getSnapshot(): CreationLastUsedState {
  return state
}

/** Subscribe to the shared creation last-used state. */
export function useCreationLastUsedState(): CreationLastUsedState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
