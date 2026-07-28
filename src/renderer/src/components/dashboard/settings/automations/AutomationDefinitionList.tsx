import type React from 'react'
import { Plus, Spinner } from '@phosphor-icons/react'
import type { AutomationDefinition } from '@shared/types'

function scopeLabel(definition: AutomationDefinition): string {
  if (definition.scope.kind === 'app') return 'App'
  return definition.scope.kind === 'workspace' ? 'Workspace' : 'Project'
}

function triggerLabel(definition: AutomationDefinition): string {
  if (definition.trigger.kind === 'event') return definition.trigger.eventType
  const seconds = definition.trigger.intervalMs / 1_000
  return seconds >= 60 && seconds % 60 === 0 ? `Every ${seconds / 60}m` : `Every ${seconds}s`
}

function EnableSwitch({
  definition,
  pending,
  onChange
}: {
  definition: AutomationDefinition
  pending: boolean
  onChange: (definition: AutomationDefinition, enabled: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={definition.enabled}
      aria-label={`${definition.enabled ? 'Disable' : 'Enable'} ${definition.name}`}
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation()
        onChange(definition, !definition.enabled)
      }}
      className={[
        'relative inline-flex items-center w-9 h-5 rounded-full transition-[background-color,opacity] duration-150',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
        'active:scale-[0.97] disabled:opacity-45 disabled:cursor-not-allowed',
        pending ? '' : 'cursor-pointer',
        definition.enabled ? 'bg-accent' : 'bg-surface-overlay'
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-150',
          definition.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]'
        ].join(' ')}
      >
        {pending && <Spinner size={9} className="animate-spin text-surface-overlay" />}
      </span>
    </button>
  )
}

export function AutomationDefinitionList({
  definitions,
  selectedId,
  pendingId,
  onSelect,
  onCreate,
  onEnabledChange
}: {
  definitions: readonly AutomationDefinition[]
  selectedId: string | null
  pendingId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onEnabledChange: (definition: AutomationDefinition, enabled: boolean) => void
}): React.JSX.Element {
  return (
    <aside id="setting-automation-definitions" className="w-full lg:w-[17rem] lg:flex-shrink-0">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Definitions
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-[color,background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <Plus size={12} weight="bold" aria-hidden="true" />
          New
        </button>
      </div>

      <div className="rounded-lg border border-border-default bg-surface-raised overflow-hidden">
        {definitions.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-text-secondary">No automations yet</p>
            <p className="text-xs text-text-muted mt-1">
              Create a disabled definition, review it, then enable it.
            </p>
            <button
              type="button"
              onClick={onCreate}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent text-accent-on px-3 py-1.5 text-xs font-medium hover:bg-accent-hover transition-[background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              <Plus size={12} weight="bold" aria-hidden="true" />
              New automation
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border-default/40">
            {definitions.map((definition) => {
              const selected = definition.id === selectedId
              return (
                <div
                  key={definition.id}
                  className={[
                    'flex items-start transition-colors duration-150',
                    selected ? 'bg-accent/10' : 'hover:bg-surface-overlay/60'
                  ].join(' ')}
                >
                  <button
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(definition.id)}
                    className="flex-1 min-w-0 px-3 py-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40"
                  >
                    <div className="min-w-0 pr-1">
                      <p
                        className={[
                          'text-sm font-medium truncate',
                          selected ? 'text-text-primary' : 'text-text-secondary'
                        ].join(' ')}
                      >
                        {definition.name}
                      </p>
                      <code className="block mt-1 text-[11px] font-mono text-text-muted truncate">
                        {definition.operationId}
                      </code>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span
                        className={[
                          'text-[10px] uppercase tracking-wider rounded border px-1.5 py-0.5',
                          definition.enabled
                            ? 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5'
                            : 'text-text-muted border-border-default bg-surface-overlay'
                        ].join(' ')}
                      >
                        {definition.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <span className="text-[10px] text-text-muted">
                        {scopeLabel(definition)} · {triggerLabel(definition)}
                      </span>
                    </div>
                  </button>
                  <div className="flex-shrink-0 pt-3 pr-3">
                    <EnableSwitch
                      definition={definition}
                      pending={pendingId === definition.id}
                      onChange={onEnabledChange}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
