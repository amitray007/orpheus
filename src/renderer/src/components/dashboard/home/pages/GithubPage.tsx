import { HomePageFrame } from './HomePageFrame'
import type { HomePageProps } from '../home.types'

export function GithubPage({ snapshot }: HomePageProps): React.JSX.Element {
  return (
    <HomePageFrame
      title="GitHub"
      source={snapshot.github}
      emptyCopy="No GitHub work needs attention."
    />
  )
}
