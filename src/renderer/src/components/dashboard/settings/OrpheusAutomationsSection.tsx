import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Lightning, Plus } from '@phosphor-icons/react'
import type {
  AutomationCatalog,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationRunWithEligibility,
  ProjectRecord
} from '@shared/types'
import { Button } from '../../Button'
import { ConfirmModal } from '../../ConfirmModal'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { SectionTitle, SegmentedControl } from './primitives'
import { AutomationDefinitionList } from './automations/AutomationDefinitionList'
import { AutomationEditor } from './automations/AutomationEditor'
import { AutomationRunHistory } from './automations/AutomationRunHistory'
import {
  AUTOMATION_RUN_POLL_MS,
  nextSelectedAutomationId,
  reconcileAutomationDefinitions,
  shouldConfirmAutomationNavigation,
  shouldRefreshSelectedRuns
} from './automations/automationForm'
import type { AutomationNavigationTarget } from './automations/automationForm'

type DetailTab = 'configuration' | 'runs'

type PendingAction =
  | { kind: 'save'; id: string }
  | { kind: 'enabled'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'retry'; id: string }

type Confirmation =
  | { kind: 'enable'; definition: AutomationDefinition }
  | { kind: 'delete'; definition: AutomationDefinition }
  | {
      kind: 'retry'
      definition: AutomationDefinition
      run: AutomationRunWithEligibility
    }
  | { kind: 'discard-navigation'; target: AutomationNavigationTarget }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function scopeLabel(definition: AutomationDefinition): string {
  if (definition.scope.kind === 'app') return 'the Orpheus app'
  if (definition.scope.kind === 'project') return `project ${definition.scope.projectId}`
  return `workspace ${definition.scope.workspaceId}`
}

function triggerLabel(definition: AutomationDefinition): string {
  return definition.trigger.kind === 'event'
    ? `when ${definition.trigger.eventType} is emitted`
    : `every ${definition.trigger.intervalMs.toLocaleString()} ms`
}

const HEADER = (
  <div>
    <div className="flex flex-wrap items-center gap-2">
      <SectionTitle>Automations</SectionTitle>
      <span className="rounded border border-amber-400/20 bg-amber-400/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-400">
        Local and bounded
      </span>
    </div>
    <p className="mt-1 max-w-2xl text-xs leading-relaxed text-text-muted">
      Run server-approved Orpheus operations on a schedule or allowlisted event. Definitions are
      created disabled and remain constrained by their saved scope and safety budgets.
    </p>
  </div>
)

// This component owns the finite renderer lifecycle for definitions, dirty drafts,
// confirmations, push reconciliation, and run polling in one state boundary.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function OrpheusAutomationsSection(): React.JSX.Element {
  const [catalog, setCatalog] = useState<AutomationCatalog | null>(null)
  const [definitions, setDefinitions] = useState<AutomationDefinition[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('configuration')
  const [runs, setRuns] = useState<AutomationRunWithEligibility[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [externalChangePending, setExternalChangePending] = useState(false)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const runsRequestId = useRef(0)

  const selectedDefinition =
    selectedId == null ? null : (definitions.find((item) => item.id === selectedId) ?? null)

  const refreshDefinitions = useCallback(
    async (dirtySelection: AutomationDefinition | null = null) => {
      const incoming = await window.api.automations.list()
      const reconciliation = reconcileAutomationDefinitions(incoming, dirtySelection)
      setDefinitions([...reconciliation.definitions])
      setSelectedId((current) => nextSelectedAutomationId(reconciliation.definitions, current))
      return reconciliation
    },
    []
  )

  const refreshRuns = useCallback(
    async (automationId: string, foreground = false): Promise<void> => {
      const requestId = ++runsRequestId.current
      if (foreground) setRunsLoading(true)
      try {
        const next = await window.api.automations.listRuns(automationId, 100)
        if (requestId !== runsRequestId.current) return
        setRuns(next)
        setRunsError(null)
      } catch (error) {
        if (requestId !== runsRequestId.current) return
        setRunsError(errorMessage(error))
      } finally {
        if (requestId === runsRequestId.current && foreground) setRunsLoading(false)
      }
    },
    []
  )

  const recoverAfterMutationError = useCallback(
    async (error: unknown, dirtySelection: AutomationDefinition | null = null): Promise<void> => {
      setMutationError(errorMessage(error))
      try {
        const reconciliation = await refreshDefinitions(dirtySelection)
        if (dirtySelection != null) {
          setExternalChangePending(reconciliation.preservedDirtySelection)
        }
      } catch {
        // Preserve the local draft and original mutation error when refresh also fails.
      }
    },
    [refreshDefinitions]
  )

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.automations.catalog(),
      window.api.automations.list(),
      window.api.projects.list()
    ])
      .then(([nextCatalog, nextDefinitions, nextProjects]) => {
        if (cancelled) return
        setCatalog(nextCatalog)
        setDefinitions(nextDefinitions)
        setProjects(nextProjects)
        setSelectedId((current) => nextSelectedAutomationId(nextDefinitions, current))
        setLoadingError(null)
      })
      .catch((error) => {
        if (!cancelled) setLoadingError(errorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return window.api.automations.onChanged((event) => {
      const dirtySelection =
        (editorDirty || externalChangePending) && selectedDefinition != null
          ? selectedDefinition
          : null
      void refreshDefinitions(dirtySelection)
        .then((reconciliation) => {
          setExternalChangePending(reconciliation.preservedDirtySelection)
        })
        .catch((error) => setLoadingError(errorMessage(error)))
      if (
        detailTab === 'runs' &&
        document.visibilityState === 'visible' &&
        shouldRefreshSelectedRuns(event, selectedId)
      ) {
        void refreshRuns(event.definitionId)
      }
    })
  }, [
    editorDirty,
    detailTab,
    externalChangePending,
    refreshDefinitions,
    refreshRuns,
    selectedDefinition,
    selectedId
  ])

  useEffect(() => {
    if (selectedId == null || detailTab !== 'runs') {
      runsRequestId.current++
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing history follows selection removal
      setRuns([])
      return
    }
    // Avoid showing another definition's history while the selected request is in flight.
    setRuns([])
    setRunsError(null)
    const refreshIfVisible = (foreground = false): void => {
      if (document.visibilityState === 'visible') void refreshRuns(selectedId, foreground)
    }
    refreshIfVisible(true)
    const timer = window.setInterval(() => {
      refreshIfVisible()
    }, AUTOMATION_RUN_POLL_MS)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void refreshRuns(selectedId)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [detailTab, refreshRuns, selectedId])

  async function saveDefinition(draft: AutomationDefinitionDraft): Promise<void> {
    setMutationError(null)
    const current = selectedDefinition
    setPending({ kind: 'save', id: current?.id ?? 'new' })
    try {
      const saved =
        creating || current == null
          ? await window.api.automations.create(draft)
          : await window.api.automations.update(current.id, current.updatedAt, draft)
      setEditorDirty(false)
      setExternalChangePending(false)
      await refreshDefinitions()
      setSelectedId(saved.id)
      setCreating(false)
      setDetailTab('configuration')
    } catch (error) {
      await recoverAfterMutationError(error, current)
    } finally {
      setPending(null)
    }
  }

  async function setDefinitionEnabled(
    definition: AutomationDefinition,
    enabled: boolean
  ): Promise<void> {
    setMutationError(null)
    setPending({ kind: 'enabled', id: definition.id })
    const dirtySelection =
      definition.id !== selectedId &&
      (editorDirty || externalChangePending) &&
      selectedDefinition != null
        ? selectedDefinition
        : null
    try {
      await window.api.automations.setEnabled(definition.id, definition.updatedAt, enabled)
      const reconciliation = await refreshDefinitions(dirtySelection)
      if (dirtySelection != null) {
        setExternalChangePending(reconciliation.preservedDirtySelection)
      }
    } catch (error) {
      await recoverAfterMutationError(error, dirtySelection)
    } finally {
      setPending(null)
      setConfirmation(null)
    }
  }

  async function deleteDefinition(definition: AutomationDefinition): Promise<void> {
    setMutationError(null)
    setPending({ kind: 'delete', id: definition.id })
    try {
      await window.api.automations.delete(definition.id, definition.updatedAt)
      const next = await refreshDefinitions()
      setSelectedId(nextSelectedAutomationId(next.definitions, definition.id))
      setCreating(false)
    } catch (error) {
      await recoverAfterMutationError(error, definition)
    } finally {
      setPending(null)
      setConfirmation(null)
    }
  }

  async function retryRun(run: AutomationRunWithEligibility): Promise<void> {
    setMutationError(null)
    setPending({ kind: 'retry', id: run.id })
    try {
      await window.api.automations.retryRun(run.id)
      await refreshRuns(run.automationId, true)
    } catch (error) {
      await recoverAfterMutationError(error)
      await refreshRuns(run.automationId)
    } finally {
      setPending(null)
      setConfirmation(null)
    }
  }

  function requestEnabledChange(definition: AutomationDefinition, enabled: boolean): void {
    if (definition.id === selectedId && (editorDirty || externalChangePending)) {
      setMutationError('Save or reload the selected definition before changing its enabled state.')
      return
    }
    if (enabled) {
      setConfirmation({ kind: 'enable', definition })
      return
    }
    void setDefinitionEnabled(definition, false)
  }

  function applyNavigation(target: AutomationNavigationTarget): void {
    if (target.kind === 'select') {
      setSelectedId(target.id)
      setCreating(false)
      setDetailTab('configuration')
    } else if (target.kind === 'create') {
      setCreating(true)
      setDetailTab('configuration')
    } else if (target.kind === 'cancel-create') {
      setCreating(false)
      setDetailTab('configuration')
    } else {
      setDetailTab('runs')
    }
    setMutationError(null)
    setEditorDirty(false)
    setExternalChangePending(false)
    setConfirmation(null)
  }

  function requestNavigation(target: AutomationNavigationTarget): void {
    if (shouldConfirmAutomationNavigation(editorDirty, selectedId, target)) {
      setConfirmation({ kind: 'discard-navigation', target })
      return
    }
    applyNavigation(target)
  }

  function selectDefinition(id: string): void {
    requestNavigation({ kind: 'select', id })
  }

  function beginCreate(): void {
    requestNavigation({ kind: 'create' })
  }

  function selectDetailTab(tab: DetailTab): void {
    if (tab === 'configuration') {
      setDetailTab(tab)
      return
    }
    requestNavigation({ kind: 'runs' })
  }

  async function reloadLatestDefinition(): Promise<void> {
    setMutationError(null)
    setPending({ kind: 'save', id: selectedId ?? 'reload' })
    try {
      await refreshDefinitions()
      setEditorDirty(false)
      setExternalChangePending(false)
      setEditorEpoch((current) => current + 1)
    } catch (error) {
      setLoadingError(errorMessage(error))
    } finally {
      setPending(null)
    }
  }

  async function reload(): Promise<void> {
    setLoading(true)
    setLoadingError(null)
    try {
      const [nextCatalog, nextDefinitions, nextProjects] = await Promise.all([
        window.api.automations.catalog(),
        window.api.automations.list(),
        window.api.projects.list()
      ])
      setCatalog(nextCatalog)
      setDefinitions(nextDefinitions)
      setProjects(nextProjects)
      setSelectedId((current) => nextSelectedAutomationId(nextDefinitions, current))
      setEditorDirty(false)
      setExternalChangePending(false)
      setEditorEpoch((current) => current + 1)
    } catch (error) {
      setLoadingError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        {HEADER}
        <SettingsSectionSkeleton groups={2} rowsPerGroup={4} />
      </div>
    )
  }

  if (catalog == null || loadingError != null) {
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        {HEADER}
        <div role="alert" className="rounded-lg border border-red-400/20 bg-red-400/5 p-4">
          <p className="text-sm text-red-400">Couldn’t load Automations.</p>
          {loadingError && <p className="mt-1 text-xs text-text-muted">{loadingError}</p>}
          <Button className="mt-3" variant="secondary" size="sm" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      {confirmation?.kind === 'enable' && (
        <ConfirmModal
          title="Enable automation?"
          body={
            <div className="flex flex-col gap-2">
              <p>
                <strong>{confirmation.definition.name}</strong> will run{' '}
                <code className="font-mono text-text-primary">
                  {confirmation.definition.operationId}
                </code>{' '}
                {triggerLabel(confirmation.definition)} for {scopeLabel(confirmation.definition)}.
              </p>
              <p className="text-xs text-text-muted">
                Its saved timeout, retry, concurrency, and rolling-start budgets remain enforced.
              </p>
            </div>
          }
          confirmLabel="Enable"
          onConfirm={() => setDefinitionEnabled(confirmation.definition, true)}
          onCancel={() => setConfirmation(null)}
        />
      )}
      {confirmation?.kind === 'delete' && (
        <ConfirmModal
          title="Delete automation?"
          body={
            <p>
              This permanently removes <strong>{confirmation.definition.name}</strong> and deletes
              its entire run history.
            </p>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => deleteDefinition(confirmation.definition)}
          onCancel={() => setConfirmation(null)}
        />
      )}
      {confirmation?.kind === 'retry' && (
        <ConfirmModal
          title="Retry automation run?"
          body={
            <div className="flex flex-col gap-2">
              <p>
                Queue a new retry generation for <strong>{confirmation.definition.name}</strong>{' '}
                against {scopeLabel(confirmation.definition)}?
              </p>
              <p className="text-xs text-text-muted">
                The current definition, grant, idempotency, and safety budgets will be revalidated.
              </p>
            </div>
          }
          confirmLabel="Queue retry"
          onConfirm={() => retryRun(confirmation.run)}
          onCancel={() => setConfirmation(null)}
        />
      )}
      {confirmation?.kind === 'discard-navigation' && (
        <ConfirmModal
          title="Discard unsaved changes?"
          body={
            <p>
              {confirmation.target.kind === 'select'
                ? 'Switching definitions'
                : confirmation.target.kind === 'create'
                  ? 'Starting a new automation'
                  : confirmation.target.kind === 'runs'
                    ? 'Opening run history'
                    : 'Closing this new automation'}{' '}
              will discard the fields you changed in this editor.
            </p>
          }
          confirmLabel="Discard and continue"
          destructive
          onConfirm={() => applyNavigation(confirmation.target)}
          onCancel={() => setConfirmation(null)}
        />
      )}

      <div className="flex max-w-5xl flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          {HEADER}
          <Button
            size="sm"
            onClick={beginCreate}
            disabled={pending != null || catalog.operations.length === 0}
            className="flex-shrink-0"
          >
            <Plus size={12} weight="bold" aria-hidden="true" />
            New automation
          </Button>
        </div>

        {catalog.operations.length === 0 && (
          <div role="status" className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-4">
            <div className="flex items-start gap-2">
              <Lightning
                size={15}
                className="mt-0.5 flex-shrink-0 text-amber-400"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm text-text-primary">No safe operations are available</p>
                <p className="mt-1 text-xs text-text-muted">
                  Automations can only be created from operations published by the server’s safe
                  automation catalog.
                </p>
              </div>
            </div>
          </div>
        )}

        {mutationError && (
          <div
            role="alert"
            className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-400"
          >
            {mutationError}
          </div>
        )}
        {externalChangePending && selectedDefinition != null && (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-xs font-medium text-amber-400">
                {selectedDefinition.name} changed outside this editor
              </p>
              <p className="mt-0.5 text-[11px] text-text-muted">
                Unsaved fields are preserved, but saving is blocked until you load the latest
                revision.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending != null}
              onClick={() => void reloadLatestDefinition()}
              className="flex-shrink-0"
            >
              Reload latest
            </Button>
          </div>
        )}

        <div className="flex min-h-[34rem] flex-col gap-4 lg:flex-row">
          <AutomationDefinitionList
            definitions={definitions}
            selectedId={creating ? null : selectedId}
            pendingId={pending?.kind === 'enabled' ? pending.id : null}
            onSelect={selectDefinition}
            onCreate={beginCreate}
            onEnabledChange={requestEnabledChange}
          />

          <main className="min-w-0 flex-1">
            {creating ? (
              <AutomationEditor
                key={`new:${editorEpoch}`}
                catalog={catalog}
                definition={null}
                projects={projects}
                pending={pending?.kind === 'save'}
                stale={false}
                error={mutationError}
                onSave={saveDefinition}
                onCancel={() => requestNavigation({ kind: 'cancel-create' })}
                onDelete={() => {}}
                onDirtyChange={setEditorDirty}
              />
            ) : selectedDefinition == null ? (
              <div className="flex min-h-[30rem] flex-col items-center justify-center rounded-lg border border-border-default bg-surface-raised px-6 text-center">
                <p className="text-sm text-text-secondary">Select an automation</p>
                <p className="mt-1 max-w-sm text-xs text-text-muted">
                  Review a definition and its redacted run history, or create a disabled automation
                  from the safe operation catalog.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex justify-end">
                  <SegmentedControl
                    options={[
                      { value: 'configuration', label: 'Configuration' },
                      { value: 'runs', label: 'Run history' }
                    ]}
                    value={detailTab}
                    onChange={selectDetailTab}
                    ariaLabel="Automation detail"
                  />
                </div>
                {detailTab === 'configuration' ? (
                  <AutomationEditor
                    key={`${selectedDefinition.id}:${selectedDefinition.updatedAt}:${editorEpoch}`}
                    catalog={catalog}
                    definition={selectedDefinition}
                    projects={projects}
                    pending={pending?.kind === 'save' && pending.id === selectedDefinition.id}
                    stale={externalChangePending}
                    error={mutationError}
                    onSave={saveDefinition}
                    onCancel={() => {}}
                    onDelete={(definition) => setConfirmation({ kind: 'delete', definition })}
                    onDirtyChange={setEditorDirty}
                  />
                ) : (
                  <AutomationRunHistory
                    runs={runs}
                    loading={runsLoading}
                    error={runsError}
                    pendingRetryId={pending?.kind === 'retry' ? pending.id : null}
                    onRefresh={() => void refreshRuns(selectedDefinition.id, true)}
                    onRetry={(run) =>
                      setConfirmation({ kind: 'retry', definition: selectedDefinition, run })
                    }
                  />
                )}
              </div>
            )}
          </main>
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          {pending == null
            ? 'Automation controls ready.'
            : pending.kind === 'retry'
              ? 'Queueing automation retry.'
              : 'Saving automation changes.'}
        </p>
      </div>
    </>
  )
}
