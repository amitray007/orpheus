import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps } from '../home.types'

export function ActivityPage({ snapshot }: HomePageProps): React.JSX.Element {
  return (
    <HomePageFrame
      title="Activity"
      source={snapshot.activity}
      emptyCopy="No activity is available yet."
    />
  )
}
