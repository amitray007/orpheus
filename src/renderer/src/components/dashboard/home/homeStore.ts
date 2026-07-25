import { createEmptyHomeSnapshot } from './homeFacade'
import type { HomeSnapshot } from './home.types'

const snapshot = createEmptyHomeSnapshot()
const listeners = new Set<() => void>()

export function getHomeSnapshot(): HomeSnapshot {
  return snapshot
}

export function subscribeHome(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function refreshHomeSource(source: keyof Omit<HomeSnapshot, 'counts'>): void {
  void source
  // Source adapters populate this store in later Home page tasks.
}
