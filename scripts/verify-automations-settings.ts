import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type {
  AutomationCatalog,
  AutomationDefinition,
  AutomationOperationCatalogEntry
} from '../src/shared/types'
import {
  AUTOMATION_RUN_POLL_MS,
  automationFormIsDirty,
  buildAutomationDraft,
  emptyAutomationForm,
  nextSelectedAutomationId,
  operationSchemaForm,
  reconcileAutomationDefinitions,
  shouldConfirmAutomationNavigation,
  shouldRefreshSelectedRuns,
  validateAutomationForm
} from '../src/renderer/src/components/dashboard/settings/automations/automationForm'

const operation: AutomationOperationCatalogEntry = {
  id: 'resources.listProjectMetadata',
  version: 1,
  kind: 'query',
  description: 'List project metadata.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      projectId: { type: 'string' },
      kinds: {
        type: 'array',
        items: { enum: ['mcp', 'hooks'] }
      },
      includeHidden: { type: 'boolean' },
      fixedVersion: { const: 1 }
    }
  },
  outputSchema: { type: 'object' },
  permission: 'resources.read',
  scope: { kind: 'project', inputField: 'projectId' },
  risk: { tier: 0, label: 'read' },
  declaredEffects: [],
  idempotency: 'natural'
}

const catalog: AutomationCatalog = {
  operations: [operation],
  eventTypes: ['workspace.completed'],
  limits: {
    intervalMs: { min: 1_000, max: 60_000 },
    timeoutMs: { min: 100, max: 300_000 },
    concurrencyLimit: { min: 1, max: 8 },
    retryMaxAttempts: { min: 1, max: 8 },
    retryBaseDelayMs: { min: 100, max: 60_000 },
    retryMaxDelayMs: { min: 100, max: 3_600_000 },
    runMaxElapsedMs: { min: 100, max: 86_400_000 },
    rollingWindowMs: { min: 1_000, max: 86_400_000 },
    rollingMaxStarts: { min: 1, max: 10_000 }
  },
  defaults: {
    timeoutMs: 30_000,
    concurrencyLimit: 1,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      maxElapsedMs: 900_000
    },
    rollingBudget: { windowMs: 60_000, maxStarts: 10 }
  }
}

const schemaForm = operationSchemaForm(operation)
assert.deepEqual(
  schemaForm.fields.map((field) => field.key),
  ['kinds', 'includeHidden'],
  'scope-bound fields must not be rendered'
)
assert.deepEqual(schemaForm.constants, { fixedVersion: 1 })
assert.deepEqual(schemaForm.unsupported, [])

const state = {
  ...emptyAutomationForm(catalog),
  name: 'Metadata refresh',
  projectId: 'project-1',
  params: { kinds: ['mcp'], includeHidden: true }
}
assert.deepEqual(validateAutomationForm(catalog, state), { valid: true, errors: [] })
assert.equal(automationFormIsDirty(state, { ...state }), false)
assert.equal(automationFormIsDirty(state, { ...state, name: 'Changed locally' }), true)
assert.deepEqual(buildAutomationDraft(catalog, state), {
  name: 'Metadata refresh',
  operationId: operation.id,
  params: {
    fixedVersion: 1,
    kinds: ['mcp'],
    includeHidden: true,
    projectId: 'project-1'
  },
  scope: { kind: 'project', projectId: 'project-1' },
  trigger: { kind: 'schedule', intervalMs: 60_000 },
  enabled: false,
  idempotency: 'natural',
  timeoutMs: 30_000,
  concurrencyLimit: 1,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
    maxElapsedMs: 900_000
  },
  rollingBudget: { windowMs: 60_000, maxStarts: 10 }
})

const workspaceOperation: AutomationOperationCatalogEntry = {
  ...operation,
  id: 'settings.getEffective',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { workspaceId: { type: 'string' } }
  },
  scope: { kind: 'workspace', inputField: 'workspaceId' }
}
const workspaceCatalog: AutomationCatalog = {
  ...catalog,
  operations: [workspaceOperation]
}
const workspaceDraft = buildAutomationDraft(workspaceCatalog, {
  ...emptyAutomationForm(workspaceCatalog),
  name: 'Workspace settings',
  projectId: 'project-1',
  workspaceId: 'workspace-1'
})
assert.deepEqual(workspaceDraft?.scope, {
  kind: 'workspace',
  projectId: 'project-1',
  workspaceId: 'workspace-1'
})
assert.deepEqual(workspaceDraft?.params, { workspaceId: 'workspace-1' })
assert.equal(workspaceDraft?.idempotency, workspaceOperation.idempotency)
assert.equal(workspaceDraft?.enabled, false)

const selfOperation: AutomationOperationCatalogEntry = {
  ...operation,
  id: 'self.get',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { includeHidden: { type: 'boolean' } }
  },
  scope: { kind: 'self' }
}
const selfCatalog: AutomationCatalog = { ...catalog, operations: [selfOperation] }
const selfState = {
  ...emptyAutomationForm(selfCatalog),
  name: 'Bound self read',
  projectId: 'project-1',
  workspaceId: 'workspace-1',
  params: { includeHidden: true }
}
assert.equal(
  validateAutomationForm(selfCatalog, { ...selfState, workspaceId: '' }).valid,
  false,
  'self operations require a workspace binding'
)
const selfDraft = buildAutomationDraft(selfCatalog, selfState)
assert.deepEqual(selfDraft?.scope, {
  kind: 'workspace',
  projectId: 'project-1',
  workspaceId: 'workspace-1'
})
assert.deepEqual(
  selfDraft?.params,
  { includeHidden: true },
  'self scope IDs must not be injected without a declared input field'
)

const fieldBoundSelfOperation: AutomationOperationCatalogEntry = {
  ...selfOperation,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { workspaceId: { type: 'string' } }
  },
  scope: { kind: 'self', inputField: 'workspaceId' }
}
const fieldBoundSelfCatalog: AutomationCatalog = {
  ...catalog,
  operations: [fieldBoundSelfOperation]
}
const fieldBoundSelfDraft = buildAutomationDraft(fieldBoundSelfCatalog, {
  ...emptyAutomationForm(fieldBoundSelfCatalog),
  name: 'Field-bound self read',
  projectId: 'project-1',
  workspaceId: 'workspace-1'
})
assert.deepEqual(fieldBoundSelfDraft?.params, { workspaceId: 'workspace-1' })

const definitions = [
  {
    id: 'automation-1',
    operationId: operation.id,
    updatedAt: 2
  },
  {
    id: 'automation-2',
    operationId: operation.id,
    updatedAt: 3
  }
] as AutomationDefinition[]
assert.equal(nextSelectedAutomationId(definitions, 'automation-2'), 'automation-2')
assert.equal(nextSelectedAutomationId(definitions, 'missing'), 'automation-1')
assert.equal(nextSelectedAutomationId([], 'automation-1'), null)
const dirtyDefinition = definitions[1]!
const refreshedDirtyDefinition = {
  ...dirtyDefinition,
  updatedAt: dirtyDefinition.updatedAt + 1
}
const dirtyReconciliation = reconcileAutomationDefinitions(
  [definitions[0]!, refreshedDirtyDefinition],
  dirtyDefinition
)
assert.equal(dirtyReconciliation.preservedDirtySelection, true)
assert.equal(
  dirtyReconciliation.definitions.find((item) => item.id === dirtyDefinition.id)?.updatedAt,
  dirtyDefinition.updatedAt,
  'push refresh must pin the dirty selected revision'
)
assert.equal(
  reconcileAutomationDefinitions(definitions, dirtyDefinition).preservedDirtySelection,
  false,
  'equal revisions do not create a false conflict'
)
const deletedDirtyReconciliation = reconcileAutomationDefinitions(
  [definitions[0]!],
  dirtyDefinition
)
assert.equal(deletedDirtyReconciliation.preservedDirtySelection, true)
assert.equal(deletedDirtyReconciliation.definitions[0]?.id, dirtyDefinition.id)
assert.equal(
  shouldConfirmAutomationNavigation(true, 'automation-2', {
    kind: 'select',
    id: 'automation-2'
  }),
  false,
  're-selecting the current definition must not prompt'
)
assert.equal(
  shouldConfirmAutomationNavigation(true, 'automation-2', {
    kind: 'select',
    id: 'automation-1'
  }),
  true
)
assert.equal(shouldConfirmAutomationNavigation(true, 'automation-2', { kind: 'create' }), true)
assert.equal(
  shouldConfirmAutomationNavigation(true, 'automation-2', { kind: 'cancel-create' }),
  true
)
assert.equal(shouldConfirmAutomationNavigation(true, 'automation-2', { kind: 'runs' }), true)
assert.equal(shouldConfirmAutomationNavigation(false, 'automation-2', { kind: 'runs' }), false)
assert.equal(
  shouldRefreshSelectedRuns(
    { kind: 'run-retried', definitionId: 'automation-2', updatedAt: 4 },
    'automation-2'
  ),
  true
)
assert.equal(
  shouldRefreshSelectedRuns(
    { kind: 'updated', definitionId: 'automation-1', updatedAt: 4 },
    'automation-2'
  ),
  false
)
assert.ok(AUTOMATION_RUN_POLL_MS >= 3_000 && AUTOMATION_RUN_POLL_MS <= 5_000)

const sectionSource = readFileSync(
  new URL(
    '../src/renderer/src/components/dashboard/settings/OrpheusAutomationsSection.tsx',
    import.meta.url
  ),
  'utf8'
)
assert.match(sectionSource, /window\.api\.automations\.onChanged/)
assert.match(sectionSource, /window\.setInterval/)
assert.match(sectionSource, /AUTOMATION_RUN_POLL_MS/)
assert.match(sectionSource, /expectedUpdatedAt|updatedAt/)
assert.match(sectionSource, /reconcileAutomationDefinitions/)
assert.match(sectionSource, /Reload latest/)
assert.match(sectionSource, /onDirtyChange=\{setEditorDirty\}/)
assert.match(sectionSource, /Discard unsaved changes\?/)
assert.match(sectionSource, /shouldConfirmAutomationNavigation/)
assert.match(sectionSource, /and deletes\s+its entire run history/)
assert.doesNotMatch(
  sectionSource,
  /setSelectedId\(updated\.id\)/,
  'toggling another definition must not replace the dirty editor selection'
)
assert.match(
  sectionSource,
  /const reconciliation = await refreshDefinitions\(dirtySelection\)/,
  'different-row toggles must reconcile around the dirty selected revision'
)
const recoveryStart = sectionSource.indexOf('const recoverAfterMutationError')
const recoveryEnd = sectionSource.indexOf('\n  useEffect(', recoveryStart)
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart)
const recoverySource = sectionSource.slice(recoveryStart, recoveryEnd)
assert.match(recoverySource, /refreshDefinitions\(dirtySelection\)/)
assert.doesNotMatch(
  recoverySource,
  /setEditorDirty\(false\)|setEditorEpoch/,
  'save errors must preserve the attempted draft and editor instance'
)
assert.match(
  sectionSource,
  /recoverAfterMutationError\(error, current\)/,
  'save errors must reconcile against the saved revision without replacing the draft'
)

const settingsViewSource = readFileSync(
  new URL('../src/renderer/src/components/dashboard/SettingsView.tsx', import.meta.url),
  'utf8'
)
const searchIndexSource = readFileSync(
  new URL('../src/renderer/src/components/dashboard/settings/searchIndex.ts', import.meta.url),
  'utf8'
)
assert.match(settingsViewSource, /orpheus-automations/)
assert.match(searchIndexSource, /Automation run history/)

console.log('Automations Settings verification passed.')
