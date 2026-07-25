import type React from 'react'
import type { HomeSourceState } from '../home.types'

interface HomePageFrameProps {
  title: string
  source: HomeSourceState<unknown>
  emptyCopy: string
  children?: React.ReactNode
}

function sourceMessage(source: HomeSourceState<unknown>, emptyCopy: string): string {
  if (source.loading) return 'Loading…'
  if (source.error) return source.error
  if (source.unavailable) return 'This source is unavailable.'
  return emptyCopy
}

export function HomePageFrame({
  title,
  source,
  emptyCopy,
  children
}: HomePageFrameProps): React.JSX.Element {
  return (
    <section
      className="mx-auto flex w-full max-w-[1180px] flex-col gap-5"
      aria-labelledby="home-page-title"
    >
      <h1
        id="home-page-title"
        tabIndex={-1}
        className="text-xl font-semibold text-text-primary outline-none"
      >
        {title}
      </h1>
      {children ?? (
        <div className="rounded-lg border border-border-default bg-surface-raised p-5 text-sm text-text-secondary">
          {sourceMessage(source, emptyCopy)}
        </div>
      )}
    </section>
  )
}
