import { useEffect, useState } from 'react'
import type React from 'react'
import { CaretDown } from '@phosphor-icons/react'
import type { ClaudeSubagent } from '@shared/types'

type AgentGroup = { key: string; label: string; agents: ClaudeSubagent[] }

function groupAgents(agents: ClaudeSubagent[]): AgentGroup[] {
  const groups: AgentGroup[] = []

  const userAgents = agents.filter((a) => a.source === 'user')
  if (userAgents.length > 0) {
    groups.push({ key: 'user', label: 'User · ~/.claude/agents', agents: userAgents })
  }

  const projectGroups = new Map<string, AgentGroup>()
  for (const a of agents) {
    if (a.source !== 'project' || !a.projectId) continue
    let group = projectGroups.get(a.projectId)
    if (!group) {
      group = {
        key: `project:${a.projectId}`,
        label: `Project · ${a.projectName ?? a.projectId}`,
        agents: []
      }
      projectGroups.set(a.projectId, group)
    }
    group.agents.push(a)
  }
  for (const g of projectGroups.values()) groups.push(g)

  return groups
}

// Keys already surfaced as named chips/fields — omit from the extra frontmatter grid to avoid redundancy
const PROMOTED_KEYS = new Set(['name', 'description', 'tools', 'model'])

export function ClaudeSubagentsSection(): React.JSX.Element {
  const [agents, setAgents] = useState<ClaudeSubagent[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedPath, setExpandedPath] = useState<string | null>(null)

  useEffect(() => {
    window.api.claudeAgents
      .listSubagents()
      .then((a) => { setAgents(a); setLoading(false) })
      .catch((err) => { console.error('[subagents] load failed', err); setLoading(false) })
  }, [])

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Subagents</h2>
        <p className="text-xs text-text-muted mt-1">
          Read-only list of subagents from ~/.claude/agents/ and each project's .claude/agents/.
          Edit the files directly to add new subagents.
        </p>
      </div>

      <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
        {loading ? (
          <AgentSkeleton />
        ) : agents.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
            <p className="text-xs text-text-muted">
              No subagents found in ~/.claude/agents/ or any project's .claude/agents/
            </p>
            <p className="text-xs text-text-muted mt-1">
              Create .md files in those directories to define custom subagents.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groupAgents(agents).map((group) => (
              <div key={group.key} className="flex flex-col">
                <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">
                  {group.label}
                </div>
                {group.agents.map((agent) => {
                  const isExpanded = expandedPath === agent.path
                  const extraKeys = Object.keys(agent.frontmatter).filter(
                    (k) => !PROMOTED_KEYS.has(k)
                  )
                  return (
                    <div
                      key={`${group.key}:${agent.path}`}
                      className="border-b border-border-default/40 last:border-b-0"
                    >
                      {/* Row header — full row is the click target */}
                      <button
                        type="button"
                        onClick={() => setExpandedPath((cur) => (cur === agent.path ? null : agent.path))}
                        className="w-full flex items-start justify-between py-2.5 gap-3 text-left cursor-pointer"
                      >
                        <div className="flex flex-col min-w-0 gap-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm text-text-primary font-medium">{agent.name}</span>
                            {agent.model && (
                              <span className="text-[10px] text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 flex-shrink-0 font-mono">
                                {agent.model}
                              </span>
                            )}
                            {agent.tools && (
                              <span
                                className="text-[10px] text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 flex-shrink-0"
                                title={agent.tools.join(', ')}
                              >
                                {agent.tools.length} tool{agent.tools.length !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          {agent.description && (
                            <p className="text-xs text-text-muted truncate">{agent.description}</p>
                          )}
                        </div>
                        <CaretDown
                          size={14}
                          className="flex-shrink-0 mt-0.5 text-text-muted transition-transform duration-150"
                          style={{ transform: isExpanded ? 'rotate(180deg)' : 'none' }}
                        />
                      </button>

                      {/* Expanded drawer */}
                      {isExpanded && (
                        <div className="border-t border-border-default/40 ml-0 pl-3 border-l border-border-default/40 mb-2 pt-2 pb-1 flex flex-col gap-2">
                          {/* Full description (untruncated) */}
                          {agent.description && (
                            <p className="text-xs text-text-secondary leading-relaxed">
                              {agent.description}
                            </p>
                          )}

                          {/* Extra frontmatter keys not already shown as chips */}
                          {extraKeys.length > 0 && (
                            <div className="flex flex-col gap-0.5">
                              {extraKeys.map((k) => {
                                const v = agent.frontmatter[k]
                                const display = Array.isArray(v) ? v.join(', ') : v
                                return (
                                  <div key={k} className="flex gap-2 text-[11px]">
                                    <span className="text-text-muted font-mono flex-shrink-0">{k}:</span>
                                    <span className="text-text-secondary break-all">{display}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}

                          {/* Body preview */}
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-text-muted">Body</span>
                            {agent.bodyPreview ? (
                              <div className="font-mono whitespace-pre-wrap text-[11px] text-text-secondary leading-relaxed bg-surface-overlay rounded px-2 py-1.5">
                                {agent.bodyPreview}
                              </div>
                            ) : (
                              <p className="text-[11px] text-text-muted italic">(no body content)</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AgentSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-1.5 py-2.5">
          <div className="flex items-center gap-2">
            <div className="h-4 w-28 rounded bg-surface-overlay" />
            <div className="h-4 w-14 rounded bg-surface-overlay" />
          </div>
          <div className="h-3 w-48 rounded bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}
