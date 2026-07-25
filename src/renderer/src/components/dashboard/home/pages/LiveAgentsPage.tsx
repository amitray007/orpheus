import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps } from '../home.types'

export function LiveAgentsPage({ snapshot }: HomePageProps): React.JSX.Element {
  return <HomePageFrame title="Live agents" source={snapshot.agents} emptyCopy="No live agents." />
}
