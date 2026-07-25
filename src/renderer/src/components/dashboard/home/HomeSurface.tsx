import { HOME_PAGE_COMPONENTS } from './homeNavigation'
import type {
  HomeCounts,
  HomePageId,
  HomeSnapshot,
  NavigateSurface,
  NavigateWorkspace
} from './home.types'

export interface HomeSurfaceProps {
  page: HomePageId
  counts: HomeCounts
  collapsed: boolean
  sidebarWidth: number
  snapshot: HomeSnapshot
  onNavigate: NavigateSurface
  onSelectWorkspace: NavigateWorkspace
}

export function HomeSurface({
  page,
  counts,
  collapsed,
  sidebarWidth,
  snapshot,
  onNavigate,
  onSelectWorkspace
}: HomeSurfaceProps): React.JSX.Element {
  const Page = HOME_PAGE_COMPONENTS[page]
  void counts

  return (
    <div
      className="min-w-0"
      data-sidebar-collapsed={collapsed}
      style={{ '--home-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <Page snapshot={snapshot} onNavigate={onNavigate} onSelectWorkspace={onSelectWorkspace} />
    </div>
  )
}
