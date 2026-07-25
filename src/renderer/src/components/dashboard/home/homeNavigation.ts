import {
  ChartBar,
  Gauge,
  GithubLogo,
  House,
  Pulse,
  Robot,
  WarningCircle
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import type { HomePageComponent, HomePageId, HomeCounts } from './home.types'
import { HomeOverviewPage } from './pages/HomeOverviewPage'
import { NeedsYouPage } from './pages/NeedsYouPage'
import { LiveAgentsPage } from './pages/LiveAgentsPage'
import { GithubPage } from './pages/GithubPage'
import { LimitsPage } from './pages/LimitsPage'
import { ActivityPage } from './pages/ActivityPage'
import { StatsPage } from './pages/StatsPage'

export const HOME_NAV_ITEMS: ReadonlyArray<{
  id: HomePageId
  label: string
  icon: Icon
  countKey?: keyof HomeCounts
  group: 'operations' | 'insights'
}> = [
  { id: 'overview', label: 'Overview', icon: House, group: 'operations' },
  {
    id: 'needs-you',
    label: 'Needs you now',
    icon: WarningCircle,
    countKey: 'needsYou',
    group: 'operations'
  },
  {
    id: 'live-agents',
    label: 'Live agents',
    icon: Robot,
    countKey: 'liveAgents',
    group: 'operations'
  },
  { id: 'github', label: 'GitHub', icon: GithubLogo, countKey: 'github', group: 'operations' },
  { id: 'limits', label: 'Limits', icon: Gauge, group: 'insights' },
  { id: 'activity', label: 'Activity', icon: Pulse, group: 'insights' },
  { id: 'stats', label: 'Stats', icon: ChartBar, group: 'insights' }
]

export const HOME_PAGE_COMPONENTS: Readonly<Record<HomePageId, HomePageComponent>> = {
  overview: HomeOverviewPage,
  'needs-you': NeedsYouPage,
  'live-agents': LiveAgentsPage,
  github: GithubPage,
  limits: LimitsPage,
  activity: ActivityPage,
  stats: StatsPage
}
