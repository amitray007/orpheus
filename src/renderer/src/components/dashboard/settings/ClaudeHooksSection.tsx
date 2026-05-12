import { useEffect, useState } from 'react'
import type React from 'react'
import type { ClaudeHookEntry } from '@shared/types'

// ---------------------------------------------------------------------------
// ClaudeHooksSection — lifecycle event handlers
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
  // Collect distinct source groups (user first, then project by name)
  const groupMap = new Map<string, { label: string; filePath: string; entries: ClaudeHookEntry[] }>()

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
    // Sub-group by event, preserving the sort order already applied by the backend
    const eventMap = new Map<string, ClaudeHookEntry[]>()
    for (const e of entries) {
      if (!eventMap.has(e.event)) eventMap.set(e.event, [])
      eventMap.get(e.event)!.push(e)
    }
    const byEvent = Array.from(eventMap.entries()).map(([event, evEntries]) => ({ event, entries: evEntries }))
    return { key, label, filePath, byEvent }
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ClaudeHooksSection(): React.JSX.Element {
  const [hooks, setHooks] = useState<ClaudeHookEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.claudeHooks
      .list()
      .then((h) => { setHooks(h); setLoading(false) })
      .catch((err) => { console.error('[hooks] load failed', err); setLoading(false) })
  }, [])

  const groups = groupHooks(hooks)

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
            after a session ends, when Claude stops, and more. They're defined in{' '}
            <code className="text-xs font-mono bg-surface-overlay px-1 py-0.5 rounded">
              ~/.claude/settings.json
            </code>{' '}
            and scoped per event type.
          </p>
          <p className="text-xs text-text-muted mt-2">
            Supported events: {HOOK_EVENTS.join(', ')}
          </p>
        </div>
      </section>

      {/* Configured hooks */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Configured hooks
        </h3>

        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          {loading ? (
            <HookSkeleton />
          ) : hooks.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
              <p className="text-xs text-text-muted">No hooks configured</p>
              <p className="text-xs text-text-muted mt-1">
                Edit{' '}
                <code className="font-mono bg-surface-overlay px-1 py-0.5 rounded">
                  ~/.claude/settings.json
                </code>{' '}
                to add hooks under the <code className="font-mono">hooks</code> key.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {groups.map((group) => (
                <div key={group.key} className="flex flex-col gap-2">
                  {/* Source group header with "Open file" button */}
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
                      {entries.map((entry, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 py-2 border-b border-border-default/40 last:border-b-0 min-w-0"
                        >
                          {entry.matcher !== null && (
                            <span className="flex-shrink-0 text-[10px] font-mono bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 text-text-secondary">
                              {entry.matcher}
                            </span>
                          )}
                          <span
                            className="text-xs font-mono text-text-primary truncate min-w-0"
                            title={entry.command}
                          >
                            {entry.command}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
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
