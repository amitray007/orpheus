import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type {
  AutomationCatalog,
  AutomationDefinition,
  AutomationOperationCatalogEntry
} from '../src/shared/types'
import {
  AUTOMATION_RUN_POLL_MS,
  automationFormFromDefinition,
  automationFormIsDirty,
  automationScopeEditorMode,
  buildAutomationDraft,
  emptyAutomationForm,
  nextSelectedAutomationId,
  operationSchemaForm,
  reconcileAutomationDefinitions,
  resetOperation,
  SETTINGS_PATCH_WORKSPACE_OPERATION_ID,
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
assert.equal(
  automationFormIsDirty(state, { ...state, scopeKind: 'workspace' }),
  true,
  'changing only the scope level must mark the form dirty'
)
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
const projectDraft = buildAutomationDraft(catalog, state)
assert.ok(projectDraft != null)
const workspaceScopedProjectDefinition: AutomationDefinition = {
  ...projectDraft,
  id: 'automation-workspace-narrowed',
  scope: {
    kind: 'workspace',
    projectId: 'project-1',
    workspaceId: 'workspace-1'
  },
  enabled: false,
  operationVersion: 1,
  nextRunAt: null,
  createdAt: 10,
  updatedAt: 11
}
const narrowedState = automationFormFromDefinition(workspaceScopedProjectDefinition)
assert.equal(narrowedState.scopeKind, 'workspace')
assert.equal(narrowedState.projectId, 'project-1')
assert.equal(narrowedState.workspaceId, 'workspace-1')
assert.equal(
  automationScopeEditorMode(operation, narrowedState),
  'workspace',
  'project descriptors must render the persisted narrower workspace controls'
)
const narrowedRoundTrip = buildAutomationDraft(catalog, narrowedState)
assert.deepEqual(narrowedRoundTrip?.scope, workspaceScopedProjectDefinition.scope)
assert.equal(
  (narrowedRoundTrip?.params as Record<string, unknown>)['projectId'],
  'project-1',
  'project descriptor input binding remains projectId inside a workspace scope'
)
const resetNarrowedState = resetOperation(narrowedState, operation)
assert.equal(resetNarrowedState.scopeKind, 'workspace')
assert.equal(resetNarrowedState.projectId, 'project-1')
assert.equal(resetNarrowedState.workspaceId, 'workspace-1')
assert.equal(automationScopeEditorMode(operation, { scopeKind: 'app' }), 'unsupported')

const secondProjectOperation: AutomationOperationCatalogEntry = {
  ...operation,
  id: 'resources.getProjectMetadata'
}
const switchedNarrowedState = resetOperation(narrowedState, secondProjectOperation)
assert.equal(
  switchedNarrowedState.scopeKind,
  'workspace',
  'switching between project descriptors must preserve a narrower workspace scope'
)
assert.equal(switchedNarrowedState.projectId, 'project-1')
assert.equal(switchedNarrowedState.workspaceId, 'workspace-1')
const switchedProjectState = resetOperation(state, secondProjectOperation)
assert.equal(
  switchedProjectState.scopeKind,
  'project',
  'switching between project descriptors must preserve project scope'
)
assert.equal(switchedProjectState.projectId, 'project-1')
assert.equal(switchedProjectState.workspaceId, '')

const resourceOperation: AutomationOperationCatalogEntry = {
  id: 'reviews.setResolved',
  version: 1,
  kind: 'mutation',
  description: 'Set the resolved state of a local review comment.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'resolved'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 128 },
      resolved: { type: 'boolean' }
    }
  },
  outputSchema: { type: 'object' },
  permission: 'reviews.resolve',
  scope: { kind: 'resource', inputField: 'id' },
  risk: { tier: 2, label: 'scoped mutation' },
  declaredEffects: ['db.write'],
  idempotency: 'natural'
}
const resourceCatalog: AutomationCatalog = {
  ...catalog,
  operations: [resourceOperation]
}
const resourceState = {
  ...emptyAutomationForm(resourceCatalog),
  name: 'Resolve review',
  projectId: 'project-1',
  params: { resolved: true }
}
assert.equal(
  automationScopeEditorMode(resourceOperation, resourceState),
  'unsupported',
  'real resource descriptors must stay outside the safe scope editor'
)
assert.equal(
  buildAutomationDraft(resourceCatalog, resourceState),
  null,
  'resource-scoped operations must fail closed during draft construction'
)

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
assert.equal(
  automationScopeEditorMode(workspaceOperation, { scopeKind: 'project' }),
  'unsupported',
  'workspace descriptors must never be widened to project scope'
)
const switchedToWorkspaceState = resetOperation(state, workspaceOperation)
assert.equal(
  switchedToWorkspaceState.scopeKind,
  'workspace',
  'workspace descriptors must narrow incompatible project scope'
)
assert.equal(switchedToWorkspaceState.projectId, 'project-1')
assert.equal(
  switchedToWorkspaceState.workspaceId,
  '',
  'narrowing must retain an existing workspace ID when available but cannot invent one'
)
assert.equal(
  validateAutomationForm(workspaceCatalog, switchedToWorkspaceState).valid,
  false,
  'a newly narrowed workspace scope remains incomplete until a workspace is selected'
)

const settingsPatchOperation: AutomationOperationCatalogEntry = {
  id: SETTINGS_PATCH_WORKSPACE_OPERATION_ID,
  version: 1,
  kind: 'mutation',
  description: 'Patch exact workspace settings.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['patch'],
    properties: {
      workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
      patch: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          model: {
            anyOf: [
              {
                type: 'string',
                minLength: 1,
                maxLength: 255,
                pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
              },
              { type: 'null' }
            ]
          },
          effort: {
            anyOf: [{ enum: ['low', 'medium', 'high'] }, { type: 'null' }]
          }
        }
      }
    }
  },
  outputSchema: { type: 'object' },
  permission: 'settings.workspace.patch',
  scope: { kind: 'workspace', inputField: 'workspaceId' },
  risk: { tier: 2, label: 'write' },
  declaredEffects: ['db.write', 'workspace.dirty.recompute'],
  idempotency: 'natural'
}
const settingsPatchCatalog: AutomationCatalog = {
  ...catalog,
  operations: [settingsPatchOperation]
}
const settingsPatchForm = operationSchemaForm(settingsPatchOperation)
assert.deepEqual(
  settingsPatchForm.fields.map(({ kind, key }) => ({ kind, key })),
  [{ kind: 'settings-patch', key: 'patch' }],
  'only the fixed settings patch object may use the nested editor'
)
assert.deepEqual(settingsPatchForm.unsupported, [])
const emptySettingsPatchState = {
  ...emptyAutomationForm(settingsPatchCatalog),
  name: 'Tune workspace',
  projectId: 'project-1',
  workspaceId: 'workspace-1'
}
assert.equal(
  validateAutomationForm(settingsPatchCatalog, emptySettingsPatchState).valid,
  false,
  'a settings patch must select at least one allowlisted change'
)
const settingsPatchState = {
  ...emptySettingsPatchState,
  params: { patch: { model: null, effort: 'high' } }
}
assert.deepEqual(validateAutomationForm(settingsPatchCatalog, settingsPatchState), {
  valid: true,
  errors: []
})
const settingsPatchDraft = buildAutomationDraft(settingsPatchCatalog, settingsPatchState)
assert.deepEqual(settingsPatchDraft?.scope, {
  kind: 'workspace',
  projectId: 'project-1',
  workspaceId: 'workspace-1'
})
assert.deepEqual(settingsPatchDraft?.params, {
  patch: { model: null, effort: 'high' },
  workspaceId: 'workspace-1'
})
assert.equal(settingsPatchDraft?.enabled, false, 'settings patch creation must start disabled')
assert.equal(settingsPatchDraft?.idempotency, 'natural')
assert.equal(
  validateAutomationForm(settingsPatchCatalog, {
    ...settingsPatchState,
    params: { patch: { model: ' invalid ' } }
  }).valid,
  false,
  'invalid model identifiers must fail before persistence'
)
assert.equal(
  validateAutomationForm(settingsPatchCatalog, {
    ...settingsPatchState,
    params: { patch: { apiKey: 'forbidden' } }
  }).valid,
  false,
  'the nested editor must reject arbitrary patch properties'
)
assert.ok(settingsPatchDraft)
const settingsPatchDefinition: AutomationDefinition = {
  ...settingsPatchDraft,
  id: 'automation-settings-patch',
  enabled: false,
  operationVersion: 1,
  nextRunAt: 60_000,
  createdAt: 10,
  updatedAt: 11
}
const replayedSettingsPatch = buildAutomationDraft(
  settingsPatchCatalog,
  automationFormFromDefinition(settingsPatchDefinition)
)
assert.deepEqual(
  replayedSettingsPatch?.params,
  settingsPatchDraft.params,
  'persisted nested clear/set semantics must survive editor replay'
)

const arbitraryObjectOperation: AutomationOperationCatalogEntry = {
  ...settingsPatchOperation,
  id: 'settings.unsafeObject'
}
assert.deepEqual(operationSchemaForm(arbitraryObjectOperation).unsupported, ['patch'])

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
const switchedSelfToProjectState = resetOperation(selfState, secondProjectOperation)
assert.equal(
  switchedSelfToProjectState.scopeKind,
  'workspace',
  'switching from self to project must preserve the compatible workspace scope'
)
assert.equal(switchedSelfToProjectState.projectId, 'project-1')
assert.equal(switchedSelfToProjectState.workspaceId, 'workspace-1')

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
const editorSource = readFileSync(
  new URL(
    '../src/renderer/src/components/dashboard/settings/automations/AutomationEditor.tsx',
    import.meta.url
  ),
  'utf8'
)
assert.match(editorSource, /automationScopeEditorMode/)
assert.match(editorSource, /scopeMode === 'workspace'/)
assert.match(editorSource, /function SettingsPatchField/)
assert.match(editorSource, /Workspace model patch action/)
assert.match(editorSource, /Clear workspace override/)
assert.doesNotMatch(
  editorSource,
  /JSON parameters|textarea[\s\S]{0,200}JSON/,
  'the settings patch editor must not expose an arbitrary JSON parameter surface'
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
