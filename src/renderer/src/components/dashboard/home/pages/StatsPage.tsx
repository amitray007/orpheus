import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps } from '../home.types'

export function StatsPage({ snapshot }: HomePageProps): React.JSX.Element {
  return (
    <HomePageFrame
      title="Stats"
      source={snapshot.stats}
      emptyCopy="No statistics are available yet."
    />
  )
}
