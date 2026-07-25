import { useSyncExternalStore } from 'react'
import { getHomeSnapshot, subscribeHome } from './homeStore'
import type { HomeSnapshot } from './home.types'

export function useHomeSnapshot(): HomeSnapshot {
  return useSyncExternalStore(subscribeHome, getHomeSnapshot, getHomeSnapshot)
}
