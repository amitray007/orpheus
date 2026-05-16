import { useEffect, useState } from 'react'
import type React from 'react'
import { Plus, Pencil, Trash } from '@phosphor-icons/react'
import type { ClaudeHookEntry, ClaudeHookDraft, ProjectRecord } from '@shared/types'
import { ConfirmModal } from '../../ConfirmModal'

// ---------------------------------------------------------------------------
// ClaudeHooksSection — lifecycle event handlers (full CRUD)
// ---------------------------------------------------------------------------

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification'
]

// Events that support the matcher field
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse'])

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

type HookSourceGroup = {
  key: string
  label: string
  filePath: string
  byEvent: { event: string; entries: ClaudeHookEntry[] }[]
}

function groupHooks(hooks: ClaudeHookEntry[]): HookSourceGroup[] {
  const groupMap = new Map<
    string,
    { label: string; filePath: string; entries: ClaudeHookEntry[] }
  >()

  for (const h of hooks) {
    const key = h.source === 'user' ? 'user' : `project:${h.projectId}`
    if (!groupMap.has(key)) {
      const label =
        h.source === 'user'
          ? 'User · ~/.claude/settings.json'
          : `Project · ${h.projectName ?? h.projectId ?? key} · ${h.filePath}`
      groupMap.set(key, { label, filePath: h.filePath, entries: [] })
    }
    groupMap.get(key)!.entries.push(h)
  }

  return Array.from(groupMap.entries()).map(([key, { label, filePath, entries }]) => {
    const eventMap = new Map<string, ClaudeHookEntry[]>()
    for (const e of entries) {
      if (!eventMap.has(e.event)) eventMap.set(e.event, [])
      eventMap.get(e.event)!.push(e)
    }
    const byEvent = Array.from(eventMap.entries()).map(([event, evEntries]) => ({
      event,
      entries: evEntries
    }))
    return { key, label, filePath, byEvent }
  })
}

function entryKey(entry: ClaudeHookEntry): string {
  return `${entry.filePath}#${entry.event}#${entry.matcherEntryIdx}#${entry.hookIdx}`
}

// ---------------------------------------------------------------------------
// HookForm — shared add / edit form
// ---------------------------------------------------------------------------

interface HookFormValues {
  event: string
  matcher: string
  command: string
  source: 'user' | 'project'
  projectId: string
}

interface HookFormProps {
  initial: HookFormValues
  projects: ProjectRecord[]
  sourceFixed?: boolean
  onSave: (values: HookFormValues) => Promise<void>
  onCancel: () => void
}

function HookForm({
  initial,
  projects,
  sourceFixed,
  onSave,
  onCancel
}: HookFormProps): React.JSX.Element {
  const [values, setValues] = useState<HookFormValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const matcherApplies = MATCHER_EVENTS.has(values.event)

  function set<K extends keyof HookFormValues>(key: K, val: HookFormValues[K]): void {
    setValues((prev) => ({ ...prev, [key]: val }))
  }

  async function handleSave(): Promise<void> {
    if (!values.command.trim()) {
      setError('Command cannot be empty.')
      return
    }
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
    <div className="bg-surface-raised border border-border-default rounded-lg p-4 flex flex-col gap-3">
      <div className="flex gap-3">
        {/* Source */}
        <div className="flex-1 min-w-0">
          <label className={labelClass}>Source</label>
          <select
            disabled={sourceFixed}
            value={values.source === 'user' ? 'user' : values.projectId}
            onChange={(e) => {
              const val = e.target.value
              if (val === 'user') {
                set('source', 'user')
                set('projectId', '')
              } else {
                set('source', 'project')
                set('projectId', val)
              }
            }}
            className={inputClass}
          >
            <option value="user">User (~/.claude)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Project · {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Event */}
        <div className="flex-1 min-w-0">
          <label className={labelClass}>Event</label>
          <select
            value={values.event}
            onChange={(e) => set('event', e.target.value)}
            className={inputClass}
          >
            {HOOK_EVENTS.map((ev) => (
              <option key={ev} value={ev}>
                {ev}
              </option>
            ))}
          </select>
        </div>

        {/* Matcher */}
        <div className="flex-1 min-w-0">
          <label className={labelClass}>
            Matcher{' '}
            {!matcherApplies && (
              <span className="normal-case text-text-muted/60">(n/a for this event)</span>
            )}
          </label>
          <input
            type="text"
            placeholder={matcherApplies ? 'e.g. Bash' : '—'}
            disabled={!matcherApplies}
            value={matcherApplies ? values.matcher : ''}
            onChange={(e) => set('matcher', e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {/* Command */}
      <div>
        <label className={labelClass}>Command</label>
        <textarea
          rows={3}
          placeholder="shell command to run…"
          value={values.command}
          onChange={(e) => set('command', e.target.value)}
          className={`${inputClass} font-mono resize-y`}
        />
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            handleSave().catch(() => {})
          }}
          disabled={saving}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer focus:outline-none"
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

export function ClaudeHooksSection(): React.JSX.Element {
  const [hooks, setHooks] = useState<ClaudeHookEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [adding, setAdding] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [deletingEntry, setDeletingEntry] = useState<ClaudeHookEntry | null>(null)

  const defaultAddDraft: HookFormValues = {
    event: 'Stop',
    matcher: '',
    command: '',
    source: 'user',
    projectId: ''
  }

  async function reload(): Promise<void> {
    try {
      const h = await window.api.claudeHooks.list()
      setHooks(h)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load hooks')
    }
  }

  useEffect(() => {
    window.api.claudeHooks
      .list()
      .then((h) => {
        setHooks(h)
        setLoading(false)
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load hooks')
        setLoading(false)
      })

    window.api.projects
      .list()
      .then(setProjects)
      .catch(() => {})
  }, [])

  const groups = groupHooks(hooks)

  async function handleAdd(values: HookFormValues): Promise<void> {
    const draft: ClaudeHookDraft = {
      event: values.event,
      matcher:
        MATCHER_EVENTS.has(values.event) && values.matcher.trim() ? values.matcher.trim() : null,
      type: 'command',
      command: values.command.trim(),
      source: values.source,
      projectId: values.source === 'project' ? values.projectId : undefined
    }
    await window.api.claudeHooks.add(draft)
    await reload()
    setAdding(false)
  }

  async function handleUpdate(entry: ClaudeHookEntry, values: HookFormValues): Promise<void> {
    const draft = {
      event: values.event,
      matcher:
        MATCHER_EVENTS.has(values.event) && values.matcher.trim() ? values.matcher.trim() : null,
      type: 'command',
      command: values.command.trim()
    }
    await window.api.claudeHooks.update(
      entry.filePath,
      entry.event,
      entry.matcherEntryIdx,
      entry.hookIdx,
      draft
    )
    await reload()
    setEditingKey(null)
  }

  async function handleDelete(entry: ClaudeHookEntry): Promise<void> {
    await window.api.claudeHooks.delete(
      entry.filePath,
      entry.event,
      entry.matcherEntryIdx,
      entry.hookIdx
    )
    await reload()
    setDeletingEntry(null)
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Hooks</h2>
        <p className="text-xs text-text-muted mt-1">
          Lifecycle event handlers — run shell scripts or commands at key points in every Claude
          Code session.
        </p>
      </div>

      {/* What are hooks */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          What are hooks?
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Hooks let you run arbitrary shell commands at lifecycle events — before a tool fires,
            after a session ends, when Claude stops, and more. They&apos;re defined in{' '}
            <code className="text-xs font-mono bg-surface-overlay px-1 py-0.5 rounded">
              ~/.claude/settings.json
            </code>{' '}
            and scoped per event type.
          </p>
          <p className="text-xs text-text-muted mt-2">Supported events: {HOOK_EVENTS.join(', ')}</p>
        </div>
      </section>

      {/* Configured hooks */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Configured hooks
          </h3>
          <button
            type="button"
            onClick={() => {
              setAdding(true)
              setEditingKey(null)
            }}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <Plus size={12} weight="bold" />
            Add hook
          </button>
        </div>

        {/* Add form */}
        {adding && (
          <HookForm
            initial={defaultAddDraft}
            projects={projects}
            onSave={handleAdd}
            onCancel={() => setAdding(false)}
          />
        )}

        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          {loading ? (
            <HookSkeleton />
          ) : loadError ? (
            <div className="rounded-md border border-red-400/30 bg-red-400/10 px-4 py-4">
              <p className="text-xs font-medium text-red-400 mb-1">Could not load hooks</p>
              <p className="text-xs text-text-muted font-mono break-all">{loadError}</p>
            </div>
          ) : hooks.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
              <p className="text-xs text-text-muted">No hooks configured</p>
              <p className="text-xs text-text-muted mt-1">
                Use &quot;Add hook&quot; above or edit{' '}
                <code className="font-mono bg-surface-overlay px-1 py-0.5 rounded">
                  ~/.claude/settings.json
                </code>{' '}
                directly.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((group) => (
                <div key={group.key} className="flex flex-col gap-2">
                  {/* Source group header */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] uppercase tracking-wider text-text-muted truncate">
                      {group.label}
                    </div>
                    <button
                      type="button"
                      onClick={() => window.api.claudeHooks.openFile(group.filePath)}
                      className="flex-shrink-0 text-[10px] text-accent hover:underline focus:outline-none"
                    >
                      Open file
                    </button>
                  </div>

                  {/* Events within the group */}
                  {group.byEvent.map(({ event, entries }) => (
                    <div key={event} className="flex flex-col">
                      <div className="text-[10px] font-medium text-text-muted/70 mb-1 pl-0.5">
                        {event}
                      </div>
                      {entries.map((entry) => {
                        const key = entryKey(entry)
                        const isEditing = editingKey === key

                        if (isEditing) {
                          return (
                            <div key={key} className="mb-1">
                              <HookForm
                                initial={{
                                  event: entry.event,
                                  matcher: entry.matcher ?? '',
                                  command: entry.command,
                                  source: entry.source,
                                  projectId: entry.projectId ?? ''
                                }}
                                projects={projects}
                                sourceFixed
                                onSave={(values) => handleUpdate(entry, values)}
                                onCancel={() => setEditingKey(null)}
                              />
                            </div>
                          )
                        }

                        return (
                          <div
                            key={key}
                            className="group flex items-center gap-2 py-2 border-b border-border-default/40 last:border-b-0 min-w-0"
                          >
                            {entry.matcher !== null && (
                              <span className="flex-shrink-0 text-[10px] font-mono bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 text-text-secondary">
                                {entry.matcher}
                              </span>
                            )}
                            <span
                              className="text-xs font-mono text-text-primary truncate min-w-0 flex-1"
                              title={entry.command}
                            >
                              {entry.command}
                            </span>
                            {/* Row actions */}
                            <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                title="Edit hook"
                                onClick={() => {
                                  setEditingKey(key)
                                  setAdding(false)
                                }}
                                className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus:outline-none"
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                type="button"
                                title="Delete hook"
                                onClick={() => setDeletingEntry(entry)}
                                className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors focus:outline-none"
                              >
                                <Trash size={12} />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Delete confirm modal */}
      {deletingEntry && (
        <ConfirmModal
          title="Delete hook?"
          body={
            <div className="flex flex-col gap-2">
              <p>This will permanently remove the hook from the settings file.</p>
              <code className="text-xs font-mono bg-surface-overlay border border-border-default rounded px-2 py-1.5 break-all">
                {deletingEntry.command}
              </code>
            </div>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => handleDelete(deletingEntry)}
          onCancel={() => setDeletingEntry(null)}
        />
      )}
    </div>
  )
}

function HookSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-2 py-2">
          <div className="h-4 w-16 rounded bg-surface-overlay flex-shrink-0" />
          <div className="h-4 w-48 rounded bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}
