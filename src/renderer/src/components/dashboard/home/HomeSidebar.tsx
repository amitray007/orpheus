import { useRef } from 'react'
import { HOME_NAV_ITEMS } from './homeNavigation'
import type { HomeCounts, HomePageId, NavigateSurface } from './home.types'

interface HomeSidebarProps {
  page: HomePageId
  counts: HomeCounts
  collapsed: boolean
  onNavigate: NavigateSurface
}

export function HomeSidebar({
  page,
  counts,
  collapsed,
  onNavigate
}: HomeSidebarProps): React.JSX.Element {
  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label="Home pages">
      {HOME_NAV_ITEMS.map((item, index) => (
        <HomeNavigationButton
          key={item.id}
          active={item.id === page}
          collapsed={collapsed}
          count={item.countKey === undefined ? undefined : counts[item.countKey]}
          item={item}
          showGroupDivider={index > 0 && item.group !== HOME_NAV_ITEMS[index - 1].group}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  )
}

function HomeNavigationButton({
  active,
  collapsed,
  count,
  item,
  showGroupDivider,
  onNavigate
}: {
  active: boolean
  collapsed: boolean
  count: number | undefined
  item: (typeof HOME_NAV_ITEMS)[number]
  showGroupDivider: boolean
  onNavigate: NavigateSurface
}): React.JSX.Element {
  const inputRef = useRef<'pointer' | 'keyboard'>('pointer')
  const Icon = item.icon
  const countLabel = count === undefined ? '' : `, ${count}`
  const title = count === undefined ? item.label : `${item.label}: ${count}`

  return (
    <>
      {showGroupDivider && <div className="my-1 border-t border-border-default" role="separator" />}
      <button
        type="button"
        aria-label={`${item.label}${countLabel}`}
        aria-current={active ? 'page' : undefined}
        title={title}
        onPointerDown={() => {
          inputRef.current = 'pointer'
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current = 'keyboard'
        }}
        onClick={() => {
          onNavigate({ surface: 'home', homePage: item.id, input: inputRef.current })
        }}
        className={[
          'relative flex h-9 items-center rounded-md transition-colors duration-150 cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          collapsed ? 'w-9 justify-center self-center' : 'w-full gap-2.5 px-3 text-sm',
          active
            ? 'bg-accent/15 text-text-primary font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
      >
        <Icon
          size={18}
          weight={active ? 'fill' : 'regular'}
          className={active ? 'text-accent' : ''}
        />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {count !== undefined && count > 0 && (
          <span
            aria-hidden="true"
            className={[
              'rounded-full bg-surface-overlay px-1.5 py-0.5 text-[10px] tabular-nums text-text-secondary',
              collapsed ? 'absolute -right-1 -top-1 min-w-4 text-center' : 'ml-auto'
            ].join(' ')}
          >
            {count}
          </span>
        )}
      </button>
    </>
  )
}
