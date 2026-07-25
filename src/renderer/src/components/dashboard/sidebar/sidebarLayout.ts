export const COLLAPSED_SIDEBAR_WIDTH = 56

export function resolveSidebarWidth(collapsed: boolean, expandedWidth: number): number {
  return collapsed ? COLLAPSED_SIDEBAR_WIDTH : expandedWidth
}
