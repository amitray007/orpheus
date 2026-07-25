import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps } from '../home.types'

export function HomeOverviewPage({ snapshot }: HomePageProps): React.JSX.Element {
  return (
    <HomePageFrame
      title="Overview"
      source={snapshot.actions}
      emptyCopy="Nothing needs your attention."
    />
  )
}
