import { summarizeHomeAgents } from '../actionQueue'
import { HomePageFrame } from './HomePageFrame'
import type { HomeAgent, HomePageProps } from '../home.types'

const STATE_LABEL: Record<HomeAgent['state'], string> = {
  working: 'Working',
  waiting: 'Waiting',
  ready: 'Ready'
}

function LiveAgentRow({
  agent,
  onSelectWorkspace
}: {
  agent: HomeAgent
  onSelectWorkspace: HomePageProps['onSelectWorkspace']
}): React.JSX.Element {
  const workspaceId = agent.workspaceId
  const projectId = agent.projectId
  const content = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-[10px] tracking-wide text-text-muted uppercase">
          {agent.provider.label}
        </span>
        <span className="min-w-0 truncate font-medium text-text-primary">{agent.task}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-secondary">
        <span>{STATE_LABEL[agent.state]}</span>
        <span>Project {agent.projectLabel}</span>
        <span>Workspace {agent.workspaceLabel}</span>
        <span>Last activity {agent.elapsedLabel}</span>
      </div>
    </>
  )

  if (workspaceId === undefined || projectId === undefined) {
    return (
      <li className="rounded-lg border border-border-default bg-surface-raised px-4 py-3">
        {content}
      </li>
    )
  }

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

export function LiveAgentsPage({ snapshot, onSelectWorkspace }: HomePageProps): React.JSX.Element {
  const agents = snapshot.agents.data
  const summary = summarizeHomeAgents(agents)
  const stateMessage = snapshot.agents.loading
    ? 'Loading live agents…'
    : snapshot.agents.error
      ? snapshot.agents.error
      : snapshot.agents.unavailable
        ? 'This source is unavailable.'
        : 'No current live items.'

  return (
    <HomePageFrame title="Live agents" source={snapshot.agents} emptyCopy="No current live items.">
      {agents.length === 0 ? (
        <div className="rounded-lg border border-border-default bg-surface-raised p-5 text-sm text-text-secondary">
          {stateMessage}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-2" aria-label="Live agent summary">
            {(['working', 'waiting', 'ready'] as const).map((state) => (
              <div
                key={state}
                className="rounded-lg border border-border-default bg-surface-raised px-3 py-2"
              >
                <div className="text-lg font-semibold text-text-primary">{summary[state]}</div>
                <div className="text-xs text-text-secondary">{STATE_LABEL[state]}</div>
              </div>
            ))}
          </div>
          <ul className="flex flex-col gap-2">
            {agents.map((agent) => (
              <LiveAgentRow key={agent.id} agent={agent} onSelectWorkspace={onSelectWorkspace} />
            ))}
          </ul>
        </div>
      )}
    </HomePageFrame>
  )
}
