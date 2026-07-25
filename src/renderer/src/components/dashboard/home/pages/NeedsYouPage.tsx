import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps } from '../home.types'

export function NeedsYouPage({ snapshot }: HomePageProps): React.JSX.Element {
  return (
    <HomePageFrame
      title="Needs you now"
      source={snapshot.actions}
      emptyCopy="Nothing needs your attention."
    />
  )
}
