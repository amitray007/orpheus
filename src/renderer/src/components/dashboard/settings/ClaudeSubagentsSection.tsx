import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CaretDown, Plus, Pencil, Trash } from '@phosphor-icons/react'
import type { ClaudeSubagent, ClaudeSubagentDraft, ProjectRecord } from '@shared/types'
import { ConfirmModal } from '../../ConfirmModal'
import { Select } from './primitives'

// ---------------------------------------------------------------------------
// ClaudeSubagentsSection — full CRUD for ~/.claude/agents/ and project .claude/agents/
// ---------------------------------------------------------------------------

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

// Keys already surfaced as named chips/fields
const PROMOTED_KEYS = new Set(['name', 'description', 'tools', 'model'])

// ---------------------------------------------------------------------------
// SubagentForm
// ---------------------------------------------------------------------------

interface SubagentFormValues {
  name: string
  description: string
  toolsRaw: string // comma-separated
  model: string
  body: string
  source: 'user' | 'project'
  projectId: string
}

interface SubagentFormProps {
  initial: SubagentFormValues
  projects: ProjectRecord[]
  sourceFixed?: boolean
  nameFixed?: boolean
  onSave: (values: SubagentFormValues) => Promise<void>
  onCancel: () => void
  addButtonRef?: React.RefObject<HTMLButtonElement | null>
}

function SubagentForm({
  initial,
  projects,
  sourceFixed,
  nameFixed,
  onSave,
  onCancel,
  addButtonRef
}: SubagentFormProps): React.JSX.Element {
  const [values, setValues] = useState<SubagentFormValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // When the source is fixed (editing existing), jump straight to the name
    // input. Otherwise the Select primitive autofocuses its trigger via
    // autoFocus={!sourceFixed} below.
    if (sourceFixed) firstInputRef.current?.focus()
  }, [sourceFixed])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onCancel()
        addButtonRef?.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, addButtonRef])

  function set<K extends keyof SubagentFormValues>(key: K, val: SubagentFormValues[K]): void {
    setValues((prev) => ({ ...prev, [key]: val }))
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await onSave(values)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full text-xs bg-surface-overlay border border-border-default rounded-md px-2.5 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-50'
  const labelClass = 'block text-[10px] font-medium text-text-muted mb-1 uppercase tracking-wider'

  return (
    <div
      className="bg-surface-raised border border-border-default rounded-lg p-4 flex flex-col gap-3"
      role="form"
      aria-label="Subagent"
    >
      {/* Row 1: Source + Name + Model */}
      <div className="flex gap-3">
        {/* Source */}
        <div className="flex-1 min-w-0">
          <label className={labelClass}>Source</label>
          <Select
            ariaLabel="Source"
            disabled={sourceFixed}
            autoFocus={!sourceFixed}
            value={values.source === 'user' ? 'user' : values.projectId}
            onChange={(val) => {
              if (val === 'user') {
                set('source', 'user')
                set('projectId', '')
              } else {
                set('source', 'project')
                set('projectId', val)
              }
            }}
            options={[
              { value: 'user', label: 'User (~/.claude/agents)' },
              ...projects.map((p) => ({ value: p.id, label: `Project · ${p.name}` }))
            ]}
          />
        </div>

        {/* Name */}
        <div className="flex-1 min-w-0">
          <label htmlFor="agent-name" className={labelClass}>
            Name{' '}
            {nameFixed && (
              <span className="normal-case text-text-muted/60">(locked — delete to rename)</span>
            )}
          </label>
          <input
            id="agent-name"
            ref={firstInputRef}
            type="text"
            placeholder="my-agent"
            disabled={nameFixed}
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Model */}
        <div className="w-36 flex-shrink-0">
          <label htmlFor="agent-model" className={labelClass}>
            Model <span className="normal-case text-text-muted/60">(empty = inherit)</span>
          </label>
          <input
            id="agent-model"
            type="text"
            placeholder="sonnet"
            value={values.model}
            onChange={(e) => set('model', e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {/* Description */}
      <div>
        <label htmlFor="agent-description" className={labelClass}>
          Description
        </label>
        <textarea
          id="agent-description"
          rows={2}
          placeholder="What this subagent specializes in…"
          value={values.description}
          onChange={(e) => set('description', e.target.value)}
          className={`${inputClass} resize-y`}
        />
      </div>

      {/* Tools */}
      <div>
        <label htmlFor="agent-tools" className={labelClass}>
          Tools{' '}
          <span className="normal-case text-text-muted/60">
            (comma-separated, empty = all tools)
          </span>
        </label>
        <input
          id="agent-tools"
          type="text"
          placeholder="Bash, Read, Edit"
          value={values.toolsRaw}
          onChange={(e) => set('toolsRaw', e.target.value)}
          className={inputClass}
        />
      </div>

      {/* Body */}
      <div>
        <label htmlFor="agent-body" className={labelClass}>
          Body / system prompt (markdown)
        </label>
        <textarea
          id="agent-body"
          rows={10}
          placeholder="You are a specialized subagent that…"
          value={values.body}
          onChange={(e) => set('body', e.target.value)}
          className={`${inputClass} font-mono resize-y`}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-3 py-2"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            handleSave().catch(() => {})
          }}
          disabled={saving}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            onCancel()
            addButtonRef?.current?.focus()
          }}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ClaudeSubagentsSection(): React.JSX.Element {
  const [agents, setAgents] = useState<ClaudeSubagent[]>([])
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [deletingAgent, setDeletingAgent] = useState<ClaudeSubagent | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  async function reload(): Promise<void> {
    try {
      const a = await window.api.claudeAgents.listSubagents()
      setAgents(a)
    } catch (err) {
      console.error('[subagents] reload failed', err)
    }
  }

  useEffect(() => {
    window.api.claudeAgents
      .listSubagents()
      .then((a) => {
        setAgents(a)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[subagents] load failed', err)
        setLoading(false)
      })
    window.api.projects
      .list()
      .then(setProjects)
      .catch(() => {})
  }, [])

  async function handleAdd(values: SubagentFormValues): Promise<void> {
    const draft: ClaudeSubagentDraft = {
      name: values.name.trim(),
      description: values.description.trim(),
      tools: values.toolsRaw.trim()
        ? values.toolsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      model: values.model.trim(),
      body: values.body,
      source: values.source,
      projectId: values.source === 'project' ? values.projectId : undefined
    }
    await window.api.claudeAgents.addSubagent(draft)
    await reload()
    setAdding(false)
  }

  async function handleUpdate(agent: ClaudeSubagent, values: SubagentFormValues): Promise<void> {
    const draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'> = {
      name: values.name.trim(),
      description: values.description.trim(),
      tools: values.toolsRaw.trim()
        ? values.toolsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      model: values.model.trim(),
      body: values.body
    }
    await window.api.claudeAgents.updateSubagent(agent.path, draft)
    await reload()
    setEditingPath(null)
  }

  async function handleDelete(agent: ClaudeSubagent): Promise<void> {
    await window.api.claudeAgents.deleteSubagent(agent.path)
    await reload()
    setDeletingAgent(null)
  }

  const defaultAddDraft: SubagentFormValues = {
    name: '',
    description: '',
    toolsRaw: '',
    model: '',
    body: '',
    source: 'user',
    projectId: ''
  }

  function agentToFormValues(agent: ClaudeSubagent): SubagentFormValues {
    return {
      name: agent.name,
      description: agent.description ?? '',
      toolsRaw: agent.tools ? agent.tools.join(', ') : '',
      model: agent.model ?? '',
      body: agent.bodyPreview,
      source: agent.source,
      projectId: agent.projectId ?? ''
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Subagents</h2>
        <p className="text-xs text-text-muted mt-1">
          Custom subagents from ~/.claude/agents/ and each project&apos;s .claude/agents/.
        </p>
      </div>

      {/* Header + add button */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Configured subagents
        </span>
        <button
          ref={addButtonRef}
          type="button"
          aria-label="Add subagent"
          onClick={() => {
            setAdding(true)
            setEditingPath(null)
          }}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <Plus size={12} weight="bold" aria-hidden="true" />
          Add subagent
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <SubagentForm
          initial={defaultAddDraft}
          projects={projects}
          onSave={handleAdd}
          onCancel={() => {
            setAdding(false)
            addButtonRef.current?.focus()
          }}
          addButtonRef={addButtonRef}
        />
      )}

      <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
        {loading ? (
          <AgentSkeleton />
        ) : agents.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
            <p className="text-xs text-text-muted">
              No subagents found in ~/.claude/agents/ or any project&apos;s .claude/agents/
            </p>
            <p className="text-xs text-text-muted mt-1">
              Use &quot;Add subagent&quot; above to create one.
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
                  const isEditing = editingPath === agent.path
                  const isExpanded = expandedPath === agent.path && !isEditing
                  const extraKeys = Object.keys(agent.frontmatter).filter(
                    (k) => !PROMOTED_KEYS.has(k)
                  )

                  if (isEditing) {
                    return (
                      <div key={`${group.key}:${agent.path}`} className="mb-2">
                        <SubagentForm
                          initial={agentToFormValues(agent)}
                          projects={projects}
                          sourceFixed
                          nameFixed
                          onSave={(values) => handleUpdate(agent, values)}
                          onCancel={() => setEditingPath(null)}
                          addButtonRef={addButtonRef}
                        />
                      </div>
                    )
                  }

                  return (
                    <div
                      key={`${group.key}:${agent.path}`}
                      className="group border-b border-border-default/40 last:border-b-0"
                    >
                      {/* Row header */}
                      <div className="flex items-start justify-between py-2.5 gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedPath((cur) => (cur === agent.path ? null : agent.path))
                          }
                          className="flex-1 flex items-start justify-between gap-3 text-left cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
                          aria-expanded={isExpanded}
                          aria-label={`${agent.name} — ${isExpanded ? 'collapse' : 'expand'}`}
                        >
                          <div className="flex flex-col min-w-0 gap-0.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm text-text-primary font-medium">
                                {agent.name}
                              </span>
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
                              <p className="text-xs text-text-muted truncate">
                                {agent.description}
                              </p>
                            )}
                          </div>
                          <CaretDown
                            size={14}
                            className="flex-shrink-0 mt-0.5 text-text-muted transition-transform duration-150"
                            style={{ transform: isExpanded ? 'rotate(180deg)' : 'none' }}
                            aria-hidden="true"
                          />
                        </button>

                        {/* Row actions (hover-reveal) */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
                          <button
                            type="button"
                            aria-label={`Edit ${agent.name}`}
                            onClick={() => {
                              setEditingPath(agent.path)
                              setAdding(false)
                              setExpandedPath(null)
                            }}
                            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                          >
                            <Pencil size={12} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${agent.name}`}
                            onClick={() => setDeletingAgent(agent)}
                            className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                          >
                            <Trash size={12} aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      {/* Expanded drawer */}
                      {isExpanded && (
                        <div className="border-t border-border-default/40 ml-0 pl-3 border-l border-border-default/40 mb-2 pt-2 pb-1 flex flex-col gap-2">
                          {agent.description && (
                            <p className="text-xs text-text-secondary leading-relaxed">
                              {agent.description}
                            </p>
                          )}
                          {extraKeys.length > 0 && (
                            <div className="flex flex-col gap-0.5">
                              {extraKeys.map((k) => {
                                const v = agent.frontmatter[k]
                                const display = Array.isArray(v) ? v.join(', ') : v
                                return (
                                  <div key={k} className="flex gap-2 text-[11px]">
                                    <span className="text-text-muted font-mono flex-shrink-0">
                                      {k}:
                                    </span>
                                    <span className="text-text-secondary break-all">{display}</span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-text-muted">
                              Body
                            </span>
                            {agent.bodyPreview ? (
                              <div className="font-mono whitespace-pre-wrap text-[11px] text-text-secondary leading-relaxed bg-surface-overlay rounded px-2 py-1.5">
                                {agent.bodyPreview}
                              </div>
                            ) : (
                              <p className="text-[11px] text-text-muted italic">
                                (no body content)
                              </p>
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

      {/* Delete confirm modal */}
      {deletingAgent && (
        <ConfirmModal
          title="Delete subagent?"
          body={
            <div className="flex flex-col gap-2">
              <p>This will permanently delete the subagent file.</p>
              <code className="text-xs font-mono bg-surface-overlay border border-border-default rounded px-2 py-1.5 break-all">
                {deletingAgent.name}
              </code>
            </div>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => handleDelete(deletingAgent)}
          onCancel={() => setDeletingAgent(null)}
        />
      )}
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
