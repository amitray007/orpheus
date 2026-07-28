import { useEffect, useId, useMemo, useState } from 'react'
import type React from 'react'
import { FloppyDisk, Trash } from '@phosphor-icons/react'
import type {
  AutomationCatalog,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationOperationCatalogEntry,
  ProjectRecord,
  WorkspaceRecord
} from '@shared/types'
import { Button } from '../../../Button'
import { Select, Toggle } from '../primitives'
import {
  automationFormFromDefinition,
  automationFormIsDirty,
  automationScopeEditorMode,
  buildAutomationDraft,
  emptyAutomationForm,
  operationSchemaForm,
  resetOperation,
  type AutomationFormState,
  type SimpleSchemaField,
  validateAutomationForm
} from './automationForm'

const INPUT_CLASS =
  'w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 disabled:opacity-50 disabled:cursor-not-allowed'

function Field({
  label,
  description,
  htmlFor,
  children
}: {
  label: string
  description?: string | null
  htmlFor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,1.2fr)] sm:items-start sm:gap-5">
      <div>
        <label htmlFor={htmlFor} className="text-xs font-medium text-text-secondary">
          {label}
        </label>
        {description && (
          <p className="text-[11px] leading-relaxed text-text-muted">{description}</p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function BoundedNumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  disabled: boolean
  onChange: (value: number) => void
}): React.JSX.Element {
  const id = useId()
  const invalid = !Number.isSafeInteger(value) || value < min || value > max
  return (
    <Field
      label={label}
      description={`${min.toLocaleString()}–${max.toLocaleString()}`}
      htmlFor={id}
    >
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`${INPUT_CLASS} text-right font-mono ${invalid ? 'border-red-400/50' : ''}`}
      />
    </Field>
  )
}

function operationLabel(operation: AutomationOperationCatalogEntry): string {
  return operation.id
}

// SchemaField deliberately exhausts the small, server-approved field vocabulary.
// eslint-disable-next-line sonarjs/cognitive-complexity
function SchemaField({
  field,
  value,
  disabled,
  onChange
}: {
  field: SimpleSchemaField
  value: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}): React.JSX.Element {
  const id = useId()
  if (field.kind === 'boolean') {
    return (
      <Field label={field.label} description={field.description}>
        {disabled ? (
          <span className="text-xs text-text-secondary">{value === true ? 'On' : 'Off'}</span>
        ) : (
          <Toggle
            value={value === true}
            onChange={(next) => onChange(next)}
            ariaLabel={field.label}
          />
        )}
      </Field>
    )
  }
  if (field.kind === 'enum') {
    const options = [
      ...(field.required ? [] : [{ value: '', label: 'Not set' }]),
      ...field.options.map((option) => ({ value: option, label: option }))
    ]
    return (
      <Field label={field.label} description={field.description} htmlFor={id}>
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          options={options}
          onChange={onChange}
          ariaLabel={field.label}
          disabled={disabled}
          placeholder={field.required ? 'Choose…' : 'Not set'}
        />
      </Field>
    )
  }
  if (field.kind === 'enum-list') {
    const selected = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
    return (
      <Field label={field.label} description={field.description}>
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((option) => {
            const checked = selected.includes(option)
            return (
              <label
                key={option}
                className={[
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                  disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                  checked
                    ? 'border-accent/30 bg-accent/10 text-text-primary'
                    : 'border-border-default text-text-secondary'
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    onChange(
                      checked ? selected.filter((item) => item !== option) : [...selected, option]
                    )
                  }
                  className="accent-accent"
                />
                {option}
              </label>
            )
          })}
        </div>
      </Field>
    )
  }
  if (field.kind === 'number') {
    const numeric = typeof value === 'number' ? value : ''
    return (
      <Field label={field.label} description={field.description} htmlFor={id}>
        <input
          id={id}
          type="number"
          inputMode={field.integer ? 'numeric' : 'decimal'}
          step={field.integer ? 1 : 'any'}
          min={field.minimum}
          max={field.maximum}
          value={numeric}
          disabled={disabled}
          onChange={(event) =>
            onChange(event.target.value.length === 0 ? undefined : Number(event.target.value))
          }
          className={`${INPUT_CLASS} text-right font-mono`}
        />
      </Field>
    )
  }
  return (
    <Field label={field.label} description={field.description} htmlFor={id}>
      <input
        id={id}
        type="text"
        value={typeof value === 'string' ? value : ''}
        required={field.required}
        minLength={field.minLength}
        maxLength={field.maxLength}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT_CLASS}
      />
    </Field>
  )
}

function ReadOnlyPill({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex rounded border border-border-default bg-surface-overlay px-2 py-1 text-xs text-text-secondary">
      {children}
    </span>
  )
}

// The editor keeps the whole persisted definition visible in one compact form; conditional
// branches map directly to operation scope, schema field, and trigger discriminants.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function AutomationEditor({
  catalog,
  definition,
  projects,
  pending,
  stale,
  error,
  onSave,
  onCancel,
  onDelete,
  onDirtyChange
}: {
  catalog: AutomationCatalog
  definition: AutomationDefinition | null
  projects: readonly ProjectRecord[]
  pending: boolean
  stale: boolean
  error: string | null
  onSave: (draft: AutomationDefinitionDraft) => Promise<void>
  onCancel: () => void
  onDelete: (definition: AutomationDefinition) => void
  onDirtyChange: (dirty: boolean) => void
}): React.JSX.Element {
  const isCreate = definition == null
  const readOnly = definition?.enabled === true
  const [initialState] = useState<AutomationFormState>(() =>
    definition == null ? emptyAutomationForm(catalog) : automationFormFromDefinition(definition)
  )
  const [state, setState] = useState<AutomationFormState>(initialState)
  const [attempted, setAttempted] = useState(false)
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [workspacesLoading, setWorkspacesLoading] = useState(false)
  const nameId = useId()
  const operationId = useId()
  const projectId = useId()
  const workspaceId = useId()

  const operation = catalog.operations.find((item) => item.id === state.operationId) ?? null
  const schemaForm = operation == null ? null : operationSchemaForm(operation)
  const scopeMode = operation == null ? 'unsupported' : automationScopeEditorMode(operation, state)
  const validation = validateAutomationForm(catalog, state)
  const dirty = automationFormIsDirty(initialState, state)

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(
    () => () => {
      onDirtyChange(false)
    },
    [onDirtyChange]
  )

  useEffect(() => {
    if (scopeMode !== 'workspace' || state.projectId.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale workspace options follows scope selection
      setWorkspaces([])
      return
    }
    let cancelled = false
    setWorkspacesLoading(true)
    window.api.workspaces
      .listForProject(state.projectId, { scope: 'all' })
      .then((items) => {
        if (!cancelled) setWorkspaces(items)
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([])
      })
      .finally(() => {
        if (!cancelled) setWorkspacesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scopeMode, state.projectId])

  const projectOptions = useMemo(() => {
    const options = projects.map((project) => ({ value: project.id, label: project.name }))
    if (state.projectId && !options.some((option) => option.value === state.projectId)) {
      options.push({ value: state.projectId, label: `${state.projectId} (unavailable)` })
    }
    return options
  }, [projects, state.projectId])
  const workspaceOptions = useMemo(() => {
    const options = workspaces.map((workspace) => ({
      value: workspace.id,
      label: workspace.name
    }))
    if (state.workspaceId && !options.some((option) => option.value === state.workspaceId)) {
      options.push({ value: state.workspaceId, label: `${state.workspaceId} (unavailable)` })
    }
    return options
  }, [state.workspaceId, workspaces])
  const operationOptions = useMemo(() => {
    const options = catalog.operations.map((item) => ({
      value: item.id,
      label: operationLabel(item)
    }))
    if (state.operationId && !options.some((item) => item.value === state.operationId)) {
      options.push({ value: state.operationId, label: `${state.operationId} (unavailable)` })
    }
    return options
  }, [catalog.operations, state.operationId])
  const triggerKinds: readonly ('schedule' | 'event')[] =
    catalog.eventTypes.length > 0 ? ['schedule', 'event'] : ['schedule']

  function patch(next: Partial<AutomationFormState>): void {
    setState((current) => ({ ...current, ...next }))
  }

  function patchParam(key: string, value: unknown): void {
    setState((current) => ({
      ...current,
      params: { ...current.params, [key]: value }
    }))
  }

  async function submit(): Promise<void> {
    setAttempted(true)
    const draft = buildAutomationDraft(catalog, state)
    if (draft == null || readOnly || stale) return
    await onSave(draft)
  }

  return (
    <div className="flex min-h-[30rem] flex-col rounded-lg border border-border-default bg-surface-raised">
      <div className="flex items-start justify-between gap-4 border-b border-border-default/50 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
            {isCreate ? 'New automation' : 'Configuration'}
          </p>
          {!isCreate && (
            <p className="mt-1 truncate text-sm font-medium text-text-primary">{definition.name}</p>
          )}
        </div>
        {!isCreate && (
          <button
            type="button"
            disabled={definition.enabled || pending}
            onClick={() => onDelete(definition)}
            aria-label={`Delete ${definition.name}`}
            title={definition.enabled ? 'Disable this automation before deleting it' : undefined}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-text-muted hover:bg-red-400/5 hover:text-red-400 transition-[color,background-color,opacity,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Trash size={12} aria-hidden="true" />
            Delete
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
        {readOnly && (
          <div className="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2">
            <p className="text-xs font-medium text-amber-400">Enabled definitions are read-only</p>
            <p className="mt-0.5 text-[11px] text-text-muted">
              Disable this automation from the definition list before editing or deleting it.
            </p>
          </div>
        )}
        {stale && (
          <div
            role="alert"
            className="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2"
          >
            <p className="text-xs font-medium text-amber-400">A newer revision is available</p>
            <p className="mt-0.5 text-[11px] text-text-muted">
              Your unsaved fields are preserved. Reload the latest definition before saving.
            </p>
          </div>
        )}

        <section className="flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">Basics</p>
          <Field label="Name" htmlFor={nameId}>
            <input
              id={nameId}
              type="text"
              value={state.name}
              maxLength={120}
              disabled={readOnly || pending}
              autoFocus={isCreate}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="e.g. Refresh project metadata"
              className={INPUT_CLASS}
            />
          </Field>
          <Field
            label="Operation"
            description="Only server-approved operations can be persisted."
            htmlFor={operationId}
          >
            <Select
              id={operationId}
              value={state.operationId}
              options={operationOptions}
              onChange={(value) => {
                const next = catalog.operations.find((item) => item.id === value)
                if (next != null) setState((current) => resetOperation(current, next))
              }}
              ariaLabel="Automation operation"
              disabled={readOnly || pending}
              placeholder="No safe operations available"
            />
            {operation && (
              <p className="mt-1 text-[11px] text-text-muted">{operation.description}</p>
            )}
          </Field>
          <Field label="Idempotency">
            <ReadOnlyPill>{operation?.idempotency ?? 'Unavailable'}</ReadOnlyPill>
          </Field>
        </section>

        {operation && (
          <section className="flex flex-col gap-3 border-t border-border-default/40 pt-5">
            <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">
              Scope
            </p>
            {scopeMode !== 'unsupported' ? (
              <>
                {operation.scope.kind === 'self' && (
                  <p className="text-[11px] leading-relaxed text-text-muted">
                    This operation runs as the selected workspace. Scope IDs are only added to
                    parameters when the operation schema declares a scope field.
                  </p>
                )}
                {operation.scope.kind === 'project' && (
                  <Field
                    label="Scope level"
                    description="Workspace is narrower than project and preserves that exact binding."
                  >
                    <Select
                      value={scopeMode}
                      options={[
                        { value: 'project', label: 'Project' },
                        { value: 'workspace', label: 'Workspace' }
                      ]}
                      onChange={(value) =>
                        patch({
                          scopeKind: value,
                          workspaceId: value === 'workspace' ? state.workspaceId : ''
                        })
                      }
                      ariaLabel="Automation scope level"
                      disabled={readOnly || pending}
                    />
                  </Field>
                )}
                <Field label="Project" htmlFor={projectId}>
                  <Select
                    id={projectId}
                    value={state.projectId}
                    options={projectOptions}
                    onChange={(value) => patch({ projectId: value, workspaceId: '' })}
                    ariaLabel="Automation project"
                    disabled={readOnly || pending}
                    placeholder={
                      projects.length === 0 ? 'No projects available' : 'Choose a project'
                    }
                  />
                </Field>
                {scopeMode === 'workspace' && (
                  <Field label="Workspace" htmlFor={workspaceId}>
                    <Select
                      id={workspaceId}
                      value={state.workspaceId}
                      options={workspaceOptions}
                      onChange={(value) => patch({ workspaceId: value })}
                      ariaLabel="Automation workspace"
                      disabled={
                        readOnly || pending || state.projectId.length === 0 || workspacesLoading
                      }
                      placeholder={
                        workspacesLoading
                          ? 'Loading workspaces…'
                          : workspaces.length === 0
                            ? 'No workspaces available'
                            : 'Choose a workspace'
                      }
                    />
                  </Field>
                )}
              </>
            ) : (
              <div role="alert" className="text-xs text-red-400">
                This operation’s scope, or the saved scope attached to it, cannot be represented by
                the safe editor.
              </div>
            )}
          </section>
        )}

        {schemaForm && (schemaForm.fields.length > 0 || schemaForm.unsupported.length > 0) && (
          <section className="flex flex-col gap-3 border-t border-border-default/40 pt-5">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">
                Parameters
              </p>
              {operation?.scope.inputField && (
                <p className="mt-0.5 text-[11px] text-text-muted">
                  <code className="font-mono">{operation.scope.inputField}</code> is derived from
                  the selected scope.
                </p>
              )}
            </div>
            {schemaForm.fields.map((field) => (
              <SchemaField
                key={field.key}
                field={field}
                value={state.params[field.key]}
                disabled={readOnly || pending}
                onChange={(value) => patchParam(field.key, value)}
              />
            ))}
            {schemaForm.unsupported.length > 0 && (
              <div
                role="alert"
                className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2"
              >
                <p className="text-xs text-red-400">
                  This editor cannot safely represent: {schemaForm.unsupported.join(', ')}.
                </p>
              </div>
            )}
          </section>
        )}

        <section
          id="setting-automation-triggers"
          className="flex flex-col gap-3 border-t border-border-default/40 pt-5"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Trigger
          </p>
          <Field label="Trigger type">
            {readOnly ? (
              <ReadOnlyPill>{state.triggerKind === 'schedule' ? 'Schedule' : 'Event'}</ReadOnlyPill>
            ) : (
              <div
                role="radiogroup"
                aria-label="Automation trigger type"
                className="inline-flex rounded-md border border-border-default bg-surface-overlay p-0.5"
              >
                {triggerKinds.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={state.triggerKind === kind}
                    disabled={pending}
                    onClick={() => patch({ triggerKind: kind })}
                    className={[
                      'rounded px-3 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                      state.triggerKind === kind
                        ? 'bg-accent/15 text-text-primary'
                        : 'text-text-muted hover:bg-surface-raised hover:text-text-primary'
                    ].join(' ')}
                  >
                    {kind === 'schedule' ? 'Schedule' : 'Event'}
                  </button>
                ))}
              </div>
            )}
          </Field>
          {state.triggerKind === 'schedule' ? (
            <BoundedNumberField
              label="Interval (ms)"
              value={state.intervalMs}
              min={catalog.limits.intervalMs.min}
              max={catalog.limits.intervalMs.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ intervalMs: value })}
            />
          ) : (
            <Field label="Event type">
              <Select
                value={state.eventType}
                options={catalog.eventTypes.map((value) => ({ value, label: value }))}
                onChange={(value) => patch({ eventType: value })}
                ariaLabel="Automation event type"
                disabled={readOnly || pending}
              />
            </Field>
          )}
        </section>

        <details
          id="setting-automation-safety-budgets"
          className="border-t border-border-default/40 pt-5"
        >
          <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wider text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded">
            Safety budgets
          </summary>
          <div className="mt-4 flex flex-col gap-3">
            <BoundedNumberField
              label="Timeout (ms)"
              value={state.timeoutMs}
              min={catalog.limits.timeoutMs.min}
              max={catalog.limits.timeoutMs.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ timeoutMs: value })}
            />
            <BoundedNumberField
              label="Concurrency"
              value={state.concurrencyLimit}
              min={catalog.limits.concurrencyLimit.min}
              max={catalog.limits.concurrencyLimit.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ concurrencyLimit: value })}
            />
            <BoundedNumberField
              label="Retry attempts"
              value={state.retryMaxAttempts}
              min={catalog.limits.retryMaxAttempts.min}
              max={catalog.limits.retryMaxAttempts.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ retryMaxAttempts: value })}
            />
            <BoundedNumberField
              label="Retry base delay (ms)"
              value={state.retryBaseDelayMs}
              min={catalog.limits.retryBaseDelayMs.min}
              max={catalog.limits.retryBaseDelayMs.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ retryBaseDelayMs: value })}
            />
            <BoundedNumberField
              label="Retry max delay (ms)"
              value={state.retryMaxDelayMs}
              min={catalog.limits.retryMaxDelayMs.min}
              max={catalog.limits.retryMaxDelayMs.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ retryMaxDelayMs: value })}
            />
            <BoundedNumberField
              label="Max elapsed (ms)"
              value={state.retryMaxElapsedMs}
              min={catalog.limits.runMaxElapsedMs.min}
              max={catalog.limits.runMaxElapsedMs.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ retryMaxElapsedMs: value })}
            />
            <BoundedNumberField
              label="Rolling window (ms)"
              value={state.rollingWindowMs}
              min={catalog.limits.rollingWindowMs.min}
              max={catalog.limits.rollingWindowMs.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ rollingWindowMs: value })}
            />
            <BoundedNumberField
              label="Max starts per window"
              value={state.rollingMaxStarts}
              min={catalog.limits.rollingMaxStarts.min}
              max={catalog.limits.rollingMaxStarts.max}
              disabled={readOnly || pending}
              onChange={(value) => patch({ rollingMaxStarts: value })}
            />
          </div>
        </details>

        {attempted && !validation.valid && (
          <div role="alert" className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2">
            <p className="text-xs font-medium text-red-400">Review the definition</p>
            <ul className="mt-1 list-disc pl-4 text-[11px] leading-relaxed text-text-muted">
              {validation.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-400"
          >
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-default/50 px-4 py-3">
        <p className="text-[11px] text-text-muted">
          {stale
            ? 'Saving is blocked until the latest revision is loaded.'
            : isCreate
              ? 'New definitions are saved disabled.'
              : `Revision ${definition.updatedAt}`}
        </p>
        <div className="flex items-center gap-2">
          {isCreate && (
            <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            disabled={readOnly || pending || stale || catalog.operations.length === 0}
            loading={pending}
            onClick={() => void submit()}
          >
            {pending ? (
              'Saving…'
            ) : (
              <>
                <FloppyDisk size={12} aria-hidden="true" />
                {isCreate ? 'Create disabled' : readOnly ? 'Disable to edit' : 'Save changes'}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
