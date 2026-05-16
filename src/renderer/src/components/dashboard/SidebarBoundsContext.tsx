import { createContext, useContext } from 'react'
import type React from 'react'

export const SidebarBoundsContext = createContext<React.RefObject<HTMLElement | null> | null>(null)

export function useSidebarBounds(): React.RefObject<HTMLElement | null> | null {
  return useContext(SidebarBoundsContext)
}
