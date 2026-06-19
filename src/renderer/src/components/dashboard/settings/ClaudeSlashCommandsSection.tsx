import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CaretDown, Plus, Pencil, Trash } from '@phosphor-icons/react'
import type { ClaudeSlashCommand, ClaudeSlashCommandDraft, ProjectRecord } from '@shared/types'
import { ConfirmModal } from '../../ConfirmModal'
import { Select, SectionTitle, Eyebrow } from './primitives'

// ---------------------------------------------------------------------------
// ClaudeSlashCommandsSection — full CRUD for ~/.claude/commands/ and project .claude/commands/
// ---------------------------------------------------------------------------

type CommandGroup = { key: string; label: string; commands: ClaudeSlashCommand[] }

function groupCommands(commands: ClaudeSlashCommand[]): CommandGroup[] {
  const groups: CommandGroup[] = []

  const userCommands = commands.filter((c) => c.source === 'user')
  if (userCommands.length > 0) {
    groups.push({ key: 'user', label: 'User · ~/.claude/commands', commands: userCommands })
  }

  const projectGroups = new Map<string, CommandGroup>()
  for (const c of commands) {
    if (c.source !== 'project' || !c.projectId) continue
    let group = projectGroups.get(c.projectId)
    if (!group) {
      group = {
        key: `project:${c.projectId}`,
        label: `Project · ${c.projectName ?? c.projectId}`,
        commands: []
      }
      projectGroups.set(c.projectId, group)
    }
    group.commands.push(c)
  }
  for (const g of projectGroups.values()) groups.push(g)

  return groups
}

// Keys already surfaced as named chips/fields — omit from the extra frontmatter grid to avoid redundancy
const PROMOTED_KEYS = new Set(['name', 'description', 'allowed-tools', 'argument-hint'])

// ---------------------------------------------------------------------------
// SlashCommandForm
// ---------------------------------------------------------------------------

interface SlashCommandFormValues {
  name: string
  description: string
  allowedToolsRaw: string // comma-separated
  argumentHint: string
  body: string
  source: 'user' | 'project'
  projectId: string
}

interface SlashCommandFormProps {
  initial: SlashCommandFormValues
  projects: ProjectRecord[]
  sourceFixed?: boolean
  nameFixed?: boolean
  onSave: (values: SlashCommandFormValues) => Promise<void>
  onCancel: () => void
  addButtonRef?: React.RefObject<HTMLButtonElement | null>
}

function SlashCommandForm({
  initial,
  projects,
  sourceFixed,
  nameFixed,
  onSave,
  onCancel,
  addButtonRef
}: SlashCommandFormProps): React.JSX.Element {
  const [values, setValues] = useState<SlashCommandFormValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // When the source is fixed (editing existing), focus the name input.
    // Otherwise the Select primitive autofocuses its trigger via autoFocus.
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

  function set<K extends keyof SlashCommandFormValues>(
    key: K,
    val: SlashCommandFormValues[K]
  ): void {
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
  const labelClass = 'block text-xs font-medium text-text-muted mb-1 uppercase tracking-wider'

  return (
    <div
      className="bg-surface-raised border border-border-default rounded-lg p-4 flex flex-col gap-3"
      role="form"
      aria-label="Slash command"
    >
      {/* Row 1: Source + Name */}
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
              { value: 'user', label: 'User (~/.claude/commands)' },
              ...projects.map((p) => ({ value: p.id, label: `Project · ${p.name}` }))
            ]}
          />
        </div>

        {/* Name */}
        <div className="flex-1 min-w-0">
          <label htmlFor="cmd-name" className={labelClass}>
            Name{' '}
            {nameFixed && (
              <span className="normal-case text-text-muted">(locked — delete to rename)</span>
            )}
          </label>
          <input
            id="cmd-name"
            ref={firstInputRef}
            type="text"
            placeholder="my-command"
            disabled={nameFixed}
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {/* Description */}
      <div>
        <label htmlFor="cmd-description" className={labelClass}>
          Description
        </label>
        <textarea
          id="cmd-description"
          rows={2}
          placeholder="What this command does…"
          value={values.description}
          onChange={(e) => set('description', e.target.value)}
          className={`${inputClass} resize-y`}
        />
      </div>

      {/* Argument hint + Allowed tools */}
      <div className="flex gap-3">
        <div className="flex-1 min-w-0">
          <label htmlFor="cmd-arg-hint" className={labelClass}>
            Argument hint
          </label>
          <input
            id="cmd-arg-hint"
            type="text"
            placeholder="<file>"
            value={values.argumentHint}
            onChange={(e) => set('argumentHint', e.target.value)}
            className={inputClass}
          />
        </div>
        <div className="flex-1 min-w-0">
          <label htmlFor="cmd-tools" className={labelClass}>
            Allowed tools <span className="normal-case text-text-muted">(comma-separated)</span>
          </label>
          <input
            id="cmd-tools"
            type="text"
            placeholder="Bash, Read, Edit"
            value={values.allowedToolsRaw}
            onChange={(e) => set('allowedToolsRaw', e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {/* Body */}
      <div>
        <label htmlFor="cmd-body" className={labelClass}>
          Body (markdown)
        </label>
        <textarea
          id="cmd-body"
          rows={10}
          placeholder="Command instructions…"
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

export function ClaudeSlashCommandsSection(): React.JSX.Element {
  const [commands, setCommands] = useState<ClaudeSlashCommand[]>([])
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [deletingCmd, setDeletingCmd] = useState<ClaudeSlashCommand | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  async function reload(): Promise<void> {
    try {
      const c = await window.api.claudeAgents.listSlashCommands()
      setCommands(c)
    } catch (err) {
      console.error('[slash-commands] reload failed', err)
    }
  }

  useEffect(() => {
    window.api.claudeAgents
      .listSlashCommands()
      .then((c) => {
        setCommands(c)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[slash-commands] load failed', err)
        setLoading(false)
      })
    window.api.projects
      .list()
      .then(setProjects)
      .catch(() => {})
  }, [])

  async function handleAdd(values: SlashCommandFormValues): Promise<void> {
    const draft: ClaudeSlashCommandDraft = {
      name: values.name.trim(),
      description: values.description.trim(),
      allowedTools: values.allowedToolsRaw.trim()
        ? values.allowedToolsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      argumentHint: values.argumentHint.trim(),
      body: values.body,
      source: values.source,
      projectId: values.source === 'project' ? values.projectId : undefined
    }
    await window.api.claudeAgents.addSlashCommand(draft)
    await reload()
    setAdding(false)
  }

  async function handleUpdate(
    cmd: ClaudeSlashCommand,
    values: SlashCommandFormValues
  ): Promise<void> {
    const draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'> = {
      name: values.name.trim(),
      description: values.description.trim(),
      allowedTools: values.allowedToolsRaw.trim()
        ? values.allowedToolsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : null,
      argumentHint: values.argumentHint.trim(),
      body: values.body
    }
    await window.api.claudeAgents.updateSlashCommand(cmd.path, draft)
    await reload()
    setEditingPath(null)
  }

  async function handleDelete(cmd: ClaudeSlashCommand): Promise<void> {
    await window.api.claudeAgents.deleteSlashCommand(cmd.path)
    await reload()
    setDeletingCmd(null)
  }

  const defaultAddDraft: SlashCommandFormValues = {
    name: '',
    description: '',
    allowedToolsRaw: '',
    argumentHint: '',
    body: '',
    source: 'user',
    projectId: ''
  }

  function commandToFormValues(cmd: ClaudeSlashCommand): SlashCommandFormValues {
    return {
      name: cmd.name,
      description: cmd.description ?? '',
      allowedToolsRaw: cmd.allowedTools ? cmd.allowedTools.join(', ') : '',
      argumentHint: cmd.argumentHint ?? '',
      body: cmd.bodyPreview, // bodyPreview has the full body (up to 600 chars)
      source: cmd.source,
      projectId: cmd.projectId ?? ''
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <SectionTitle>Slash commands</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Custom commands from ~/.claude/commands/ and each project&apos;s .claude/commands/.
        </p>
      </div>

      {/* Header + add button */}
      <div className="flex items-center justify-between">
        <Eyebrow>Configured commands</Eyebrow>
        <button
          ref={addButtonRef}
          type="button"
          aria-label="Add slash command"
          onClick={() => {
            setAdding(true)
            setEditingPath(null)
          }}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <Plus size={12} weight="bold" aria-hidden="true" />
          Add command
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <SlashCommandForm
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
          <CommandSkeleton />
        ) : commands.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
            <p className="text-xs text-text-muted">
              No slash commands found in ~/.claude/commands/ or any project&apos;s .claude/commands/
            </p>
            <p className="text-xs text-text-muted mt-1">
              Use &quot;Add command&quot; above to create one.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groupCommands(commands).map((group) => (
              <div key={group.key} className="flex flex-col">
                <div className="text-xs uppercase tracking-wider text-text-muted mb-1.5">
                  {group.label}
                </div>
                {group.commands.map((cmd) => {
                  const isEditing = editingPath === cmd.path
                  const isExpanded = expandedPath === cmd.path && !isEditing
                  const extraKeys = Object.keys(cmd.frontmatter).filter(
                    (k) => !PROMOTED_KEYS.has(k)
                  )

                  if (isEditing) {
                    return (
                      <div key={`${group.key}:${cmd.path}`} className="mb-2">
                        <SlashCommandForm
                          initial={commandToFormValues(cmd)}
                          projects={projects}
                          sourceFixed
                          nameFixed
                          onSave={(values) => handleUpdate(cmd, values)}
                          onCancel={() => setEditingPath(null)}
                          addButtonRef={addButtonRef}
                        />
                      </div>
                    )
                  }

                  return (
                    <div
                      key={`${group.key}:${cmd.path}`}
                      className="group border-b border-border-default/40 last:border-b-0"
                    >
                      {/* Row header */}
                      <div className="flex items-start justify-between py-2.5 gap-3">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedPath((cur) => (cur === cmd.path ? null : cmd.path))
                          }
                          className="flex-1 flex items-start justify-between gap-3 text-left cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
                          aria-expanded={isExpanded}
                          aria-label={`/${cmd.name} — ${isExpanded ? 'collapse' : 'expand'}`}
                        >
                          <div className="flex flex-col min-w-0 gap-0.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm text-text-primary font-medium">
                                /{cmd.name}
                              </span>
                              {cmd.argumentHint && (
                                <span className="text-xs text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 flex-shrink-0 font-mono">
                                  {cmd.argumentHint}
                                </span>
                              )}
                              {cmd.allowedTools && (
                                <span
                                  className="text-xs text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 flex-shrink-0"
                                  title={cmd.allowedTools.join(', ')}
                                >
                                  {cmd.allowedTools.length} tool
                                  {cmd.allowedTools.length !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                            {cmd.description && (
                              <p className="text-xs text-text-muted truncate">{cmd.description}</p>
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
                            aria-label={`Edit /${cmd.name}`}
                            onClick={() => {
                              setEditingPath(cmd.path)
                              setAdding(false)
                              setExpandedPath(null)
                            }}
                            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                          >
                            <Pencil size={12} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete /${cmd.name}`}
                            onClick={() => setDeletingCmd(cmd)}
                            className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                          >
                            <Trash size={12} aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      {/* Expanded drawer */}
                      {isExpanded && (
                        <div className="border-t border-border-default/40 ml-0 pl-3 border-l border-border-default/40 mb-2 pt-2 pb-1 flex flex-col gap-2">
                          {cmd.description && (
                            <p className="text-xs text-text-secondary leading-relaxed">
                              {cmd.description}
                            </p>
                          )}
                          {extraKeys.length > 0 && (
                            <div className="flex flex-col gap-0.5">
                              {extraKeys.map((k) => {
                                const v = cmd.frontmatter[k]
                                const display = Array.isArray(v) ? v.join(', ') : v
                                return (
                                  <div key={k} className="flex gap-2 text-sm">
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
                            <span className="text-xs uppercase tracking-wider text-text-muted">
                              Body
                            </span>
                            {cmd.bodyPreview ? (
                              <div className="font-mono whitespace-pre-wrap text-sm text-text-secondary leading-relaxed bg-surface-overlay rounded px-2 py-1.5">
                                {cmd.bodyPreview}
                              </div>
                            ) : (
                              <p className="text-sm text-text-muted italic">(no body content)</p>
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
      {deletingCmd && (
        <ConfirmModal
          title="Delete slash command?"
          body={
            <div className="flex flex-col gap-2">
              <p>This will permanently delete the command file.</p>
              <code className="text-xs font-mono bg-surface-overlay border border-border-default rounded px-2 py-1.5 break-all">
                /{deletingCmd.name}
              </code>
            </div>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => handleDelete(deletingCmd)}
          onCancel={() => setDeletingCmd(null)}
        />
      )}
    </div>
  )
}

function CommandSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-1.5 py-2.5">
          <div className="flex items-center gap-2">
            <div className="h-4 w-28 rounded bg-surface-overlay" />
            <div className="h-4 w-16 rounded bg-surface-overlay" />
          </div>
          <div className="h-3 w-48 rounded bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}
