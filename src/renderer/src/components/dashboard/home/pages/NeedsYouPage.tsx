import { useMemo, useState } from 'react'
import { actionFilters, orderHomeActions, type HomeActionFilter } from '../actionQueue'
import { HomePageFrame } from './HomePageFrame'
import type { HomeActionItem, HomePageProps } from '../home.types'

const FILTER_LABEL: Record<HomeActionFilter, string> = {
  all: 'All',
  agent: 'Waiting',
  'completed-run': 'Ready',
  'github-check': 'Checks',
  'github-review': 'Reviews',
  'github-issue': 'Issues'
}

function QueueState({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-default bg-surface-raised p-5 text-sm text-text-secondary">
      {message}
    </div>
  )
}

function ActionRow({
  item,
  onSelectWorkspace
}: {
  item: HomeActionItem
  onSelectWorkspace: HomePageProps['onSelectWorkspace']
}): React.JSX.Element {
  const target = item.target
  const content = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-[10px] tracking-wide text-text-muted uppercase">
          {FILTER_LABEL[item.source]}
        </span>
        <span className="min-w-0 truncate font-medium text-text-primary">{item.title}</span>
      </div>
      {item.detail ? <p className="mt-1 text-sm text-text-secondary">{item.detail}</p> : null}
    </>
  )

  if (target?.kind !== 'workspace') {
    return (
      <li className="rounded-lg border border-border-default bg-surface-raised px-4 py-3">
        {content}
      </li>
    )
  }

  const { projectId, workspaceId } = target
  return (
    <li>
      <button
        type="button"
        className="w-full rounded-lg border border-border-default bg-surface-raised px-4 py-3 text-left hover:bg-surface-overlay focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={() => onSelectWorkspace(workspaceId, projectId)}
      >
        {content}
      </button>
    </li>
  )
}

export function NeedsYouPage({ snapshot, onSelectWorkspace }: HomePageProps): React.JSX.Element {
  const actions = useMemo(() => orderHomeActions(snapshot.actions.data), [snapshot.actions.data])
  const filters = useMemo(() => actionFilters(actions), [actions])
  const [filter, setFilter] = useState<HomeActionFilter>('all')
  // Keep the user's choice through a refresh. If its source temporarily has no
  // rows, render All without resetting the stored choice.
  const activeFilter = filters.includes(filter) ? filter : 'all'
  const visibleActions =
    activeFilter === 'all' ? actions : actions.filter((item) => item.source === activeFilter)
  const stateMessage = snapshot.actions.loading
    ? 'Loading actionable items…'
    : snapshot.actions.error
      ? snapshot.actions.error
      : snapshot.actions.unavailable
        ? 'This source is unavailable.'
        : 'No current actionable items.'

  return (
    <HomePageFrame
      title="Needs you now"
      source={snapshot.actions}
      emptyCopy="No current actionable items."
    >
      {actions.length === 0 ? (
        <QueueState message={stateMessage} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2" aria-label="Action filters">
            {filters.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={activeFilter === candidate}
                className={
                  activeFilter === candidate
                    ? 'rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white'
                    : 'rounded-full bg-surface-raised px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-overlay'
                }
                onClick={() => setFilter(candidate)}
              >
                {FILTER_LABEL[candidate]}
              </button>
            ))}
          </div>
          {visibleActions.length === 0 ? (
            <QueueState message="No current actionable items." />
          ) : (
            <ul className="flex flex-col gap-2">
              {visibleActions.map((item) => (
                <ActionRow key={item.id} item={item} onSelectWorkspace={onSelectWorkspace} />
              ))}
            </ul>
          )}
        </div>
      )}
    </HomePageFrame>
  )
}
