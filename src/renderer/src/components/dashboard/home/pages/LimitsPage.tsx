import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps } from '../home.types'

export function LimitsPage({ snapshot }: HomePageProps): React.JSX.Element {
  return (
    <HomePageFrame
      title="Limits"
      source={snapshot.limits}
      emptyCopy="No usage limits are available."
    />
  )
}
