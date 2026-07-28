import type {
  CreateWorkspaceTerminalInput,
  WorkbenchControlService
} from '../workbenchControl/service'
import type { ControlDescriptor, ControlSchema } from './types'

const ID = { type: 'string', minLength: 1, maxLength: 128 } as const
const PATH = { type: 'string', minLength: 1, maxLength: 4096 } as const
const SURFACES = ['renderer', 'mcp'] as const
const EMPTY = { type: 'object', additionalProperties: false, properties: {} } as const
const PANE = {
  type: 'object',
  additionalProperties: false,
  required: ['layoutId'],
  properties: { layoutId: ID }
} as const
const TERMINAL = {
  type: 'object',
  additionalProperties: false,
  required: ['layoutId', 'terminalId'],
  properties: { layoutId: ID, terminalId: ID }
} as const
const UI_PERMISSION = 'ui.workbench.control' as const
const UI_PRESENT = 'ui.present' as const
const MAX_INITIAL_COMMAND_BYTES = 8_192
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER

const EFFECT = {
  type: 'object',
  additionalProperties: false,
  required: ['effect', 'status'],
  properties: {
    effect: { type: 'string', minLength: 1 },
    status: { enum: ['applied', 'skipped', 'failed'] },
    workspaceId: ID,
    resourceId: { type: 'string', minLength: 1 },
    message: { type: 'string' }
  }
} as const

const WORKBENCH_STATE = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'workspaceId', 'observedAt', 'source', 'workbench', 'file', 'diff'],
  properties: {
    schemaVersion: { const: 1 },
    workspaceId: ID,
    observedAt: { type: 'number' },
    source: { const: 'renderer-live' },
    workbench: {
      type: 'object',
      additionalProperties: false,
      required: ['state', 'activeTab'],
      properties: {
        state: { enum: ['dormant', 'open', 'expanded'] },
        activeTab: { enum: ['git', 'terminal', 'files'] }
      }
    },
    file: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'mode'],
          properties: {
            path: PATH,
            mode: { enum: ['viewer', 'preview'] }
          }
        }
      ]
    },
    diff: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'path', 'reviewId'],
          properties: {
            kind: { enum: ['working-tree-file', 'local-review'] },
            path: { type: 'string' },
            reviewId: { type: ['string', 'null'] }
          }
        }
      ]
    }
  }
} as const

const PANE_STATE = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'observedAt',
    'source',
    'layoutId',
    'panelId',
    'selected',
    'focusedTerminalId',
    'terminals'
  ],
  properties: {
    schemaVersion: { const: 1 },
    observedAt: { type: 'number' },
    source: { const: 'renderer-live' },
    layoutId: ID,
    panelId: ID,
    selected: { type: 'boolean' },
    focusedTerminalId: { type: ['string', 'null'] },
    terminals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['terminalId', 'selected', 'desiredState'],
        properties: {
          terminalId: ID,
          selected: { type: 'boolean' },
          desiredState: { enum: ['running', 'stopped'] }
        }
      }
    }
  }
} as const

const PANE_LAYOUT_MUTATION = {
  type: 'object',
  additionalProperties: false,
  required: [
    'layoutId',
    'panelId',
    'terminalId',
    'layoutUpdatedAt',
    'terminalUpdatedAt',
    'observationTarget'
  ],
  properties: {
    layoutId: ID,
    panelId: ID,
    terminalId: ID,
    layoutUpdatedAt: { type: 'number' },
    terminalUpdatedAt: { type: 'number' },
    observationTarget: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'layoutId', 'paneId'],
      properties: {
        kind: { const: 'pane' },
        layoutId: ID,
        paneId: ID
      }
    }
  }
} as const

function receipt(value: ControlSchema): ControlSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'requestId',
      'operationId',
      'status',
      'target',
      'value',
      'effects',
      'auditId'
    ],
    properties: {
      schemaVersion: { const: 1 },
      requestId: ID,
      operationId: ID,
      status: { enum: ['completed', 'partial'] },
      target: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId', 'workspaceId'],
        properties: { projectId: ID, workspaceId: ID }
      },
      value,
      effects: { type: 'array', items: EFFECT },
      auditId: ID
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 4096)
    return false
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}
function empty(value: unknown): value is Record<string, never> {
  return record(value) && only(value, [])
}
function pane(value: unknown): value is { layoutId: string } {
  return record(value) && only(value, ['layoutId']) && id(value.layoutId)
}
function terminal(value: unknown): value is { layoutId: string; terminalId: string } {
  return (
    record(value) &&
    only(value, ['layoutId', 'terminalId']) &&
    id(value.layoutId) &&
    id(value.terminalId)
  )
}
function optionalLabel(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value)
  )
}
function initialCommand(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      !value.includes('\0') &&
      Buffer.byteLength(value, 'utf8') <= MAX_INITIAL_COMMAND_BYTES)
  )
}
function createWorkspaceTerminalInput(value: unknown): value is CreateWorkspaceTerminalInput {
  return (
    record(value) &&
    only(value, ['layoutName', 'terminalName', 'initialCommand']) &&
    optionalLabel(value.layoutName) &&
    optionalLabel(value.terminalName) &&
    initialCommand(value.initialCommand)
  )
}
function deleteTerminalLayoutInput(value: unknown): value is {
  layoutId: string
  terminalId: string
  expectedLayoutUpdatedAt: number
  expectedTerminalUpdatedAt: number
} {
  return (
    record(value) &&
    only(value, [
      'layoutId',
      'terminalId',
      'expectedLayoutUpdatedAt',
      'expectedTerminalUpdatedAt'
    ]) &&
    id(value.layoutId) &&
    id(value.terminalId) &&
    typeof value.expectedLayoutUpdatedAt === 'number' &&
    Number.isSafeInteger(value.expectedLayoutUpdatedAt) &&
    value.expectedLayoutUpdatedAt >= 0 &&
    value.expectedLayoutUpdatedAt <= MAX_SAFE_REVISION &&
    typeof value.expectedTerminalUpdatedAt === 'number' &&
    Number.isSafeInteger(value.expectedTerminalUpdatedAt) &&
    value.expectedTerminalUpdatedAt >= 0 &&
    value.expectedTerminalUpdatedAt <= MAX_SAFE_REVISION
  )
}

// The tuple preserves each descriptor's distinct validated input type.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createWorkbenchCapabilities(service: WorkbenchControlService) {
  const getState: ControlDescriptor<Record<string, never>, unknown> = {
    id: 'workbench.getState',
    version: 1,
    kind: 'query',
    description: 'Read live semantic Workbench UI state for the calling runtime workspace.',
    inputSchema: EMPTY,
    outputSchema: WORKBENCH_STATE,
    allowedSurfaces: SURFACES,
    permission: UI_PERMISSION,
    scope: { kind: 'self' },
    risk: { tier: 0, label: 'read' },
    declaredEffects: [],
    validateInput: empty,
    handler: (_input, context) => service.getWorkbenchState(context)
  }
  const selectTab: ControlDescriptor<{ tab: 'git' | 'terminal' | 'files' }, unknown> = {
    id: 'workbench.selectTab',
    version: 1,
    kind: 'mutation',
    description: 'Present the calling workspace Workbench and select a semantic tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tab'],
      properties: { tab: { enum: ['git', 'terminal', 'files'] } }
    },
    outputSchema: receipt(WORKBENCH_STATE),
    allowedSurfaces: SURFACES,
    permission: UI_PERMISSION,
    scope: { kind: 'self' },
    risk: { tier: 1, label: 'presentation' },
    declaredEffects: [UI_PRESENT],
    validateInput: (value): value is { tab: 'git' | 'terminal' | 'files' } =>
      record(value) &&
      only(value, ['tab']) &&
      (value.tab === 'git' || value.tab === 'terminal' || value.tab === 'files'),
    handler: (input, context) => service.selectTab(input.tab, context)
  }
  const openFile: ControlDescriptor<{ path: string; mode?: 'viewer' | 'preview' }, unknown> = {
    id: 'workbench.openFile',
    version: 1,
    kind: 'mutation',
    description: 'Open a guarded workspace-relative file in the calling workspace Workbench.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: PATH, mode: { enum: ['viewer', 'preview'] } }
    },
    outputSchema: receipt(WORKBENCH_STATE),
    allowedSurfaces: SURFACES,
    permission: UI_PERMISSION,
    scope: { kind: 'self' },
    risk: { tier: 1, label: 'presentation' },
    declaredEffects: ['filesystem.read', UI_PRESENT],
    validateInput: (value): value is { path: string; mode?: 'viewer' | 'preview' } =>
      record(value) &&
      only(value, ['path', 'mode']) &&
      isSafeRelativePath(value.path) &&
      (value.mode === undefined || value.mode === 'viewer' || value.mode === 'preview'),
    handler: (input, context) => service.openFile(input.path, input.mode ?? 'viewer', context)
  }
  const openDiff: ControlDescriptor<
    {
      target:
        | { kind: 'working-tree-file'; path: string }
        | { kind: 'local-review'; reviewId: string }
    },
    unknown
  > = {
    id: 'workbench.openDiff',
    version: 1,
    kind: 'mutation',
    description: 'Open a local working-tree diff or Orpheus review target.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['target'],
      properties: {
        target: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'path'],
              properties: { kind: { const: 'working-tree-file' }, path: PATH }
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'reviewId'],
              properties: { kind: { const: 'local-review' }, reviewId: ID }
            }
          ]
        }
      }
    },
    outputSchema: receipt(WORKBENCH_STATE),
    allowedSurfaces: SURFACES,
    permission: UI_PERMISSION,
    scope: { kind: 'self' },
    risk: { tier: 1, label: 'presentation' },
    declaredEffects: ['git.read', 'process.spawn', UI_PRESENT],
    validateInput: (
      value
    ): value is {
      target:
        | { kind: 'working-tree-file'; path: string }
        | { kind: 'local-review'; reviewId: string }
    } => {
      if (!record(value) || !only(value, ['target']) || !record(value.target)) return false
      const target = value.target
      return (
        (only(target, ['kind', 'path']) &&
          target.kind === 'working-tree-file' &&
          isSafeRelativePath(target.path)) ||
        (only(target, ['kind', 'reviewId']) &&
          target.kind === 'local-review' &&
          id(target.reviewId))
      )
    },
    handler: (input, context) => service.openDiff(input.target, context)
  }
  const paneDescriptor = (
    operation: 'getState' | 'selectLayout'
  ): ControlDescriptor<{ layoutId: string }, unknown> => ({
    id: `panes.${operation}`,
    version: 1,
    kind: operation === 'getState' ? 'query' : 'mutation',
    description:
      operation === 'getState'
        ? 'Read semantic UI intent for an authorized pane layout.'
        : 'Select an explicitly authorized persisted pane layout.',
    inputSchema: PANE,
    outputSchema: operation === 'getState' ? PANE_STATE : receipt(PANE_STATE),
    allowedSurfaces: SURFACES,
    permission: UI_PERMISSION,
    scope: { kind: 'resource', inputField: 'layoutId' },
    risk: {
      tier: operation === 'getState' ? 0 : 1,
      label: operation === 'getState' ? 'read' : 'presentation'
    },
    declaredEffects: operation === 'getState' ? [] : ['db.write', UI_PRESENT],
    validateInput: pane,
    handler: (input, context) =>
      operation === 'getState'
        ? service.getPaneState(input.layoutId, context)
        : service.selectLayout(input.layoutId, context)
  })
  const terminalDescriptor = (
    action: 'start' | 'stop' | 'focus'
  ): ControlDescriptor<{ layoutId: string; terminalId: string }, unknown> => ({
    id: `panes.${action}Terminal`,
    version: 1,
    kind: 'mutation',
    description: `${action} an explicitly authorized configured pane terminal.`,
    inputSchema: TERMINAL,
    outputSchema: receipt({
      type: 'object',
      additionalProperties: false,
      required: ['layoutId', 'terminalId'],
      properties: { layoutId: ID, terminalId: ID }
    }),
    allowedSurfaces: SURFACES,
    permission: 'terminals.control',
    scope: { kind: 'resource', inputField: 'terminalId' },
    risk: {
      tier: action === 'focus' ? 1 : 2,
      label: action === 'focus' ? 'presentation' : 'process control'
    },
    declaredEffects:
      action === 'start'
        ? ['surface.mount', 'process.spawn']
        : action === 'stop'
          ? ['surface.destroy', 'process.terminate']
          : [UI_PRESENT, 'ui.focus'],
    validateInput: terminal,
    handler: (input, context) => service.terminal(action, input.layoutId, input.terminalId, context)
  })
  const createWorkspaceTerminal: ControlDescriptor<CreateWorkspaceTerminalInput, unknown> = {
    id: 'panes.createWorkspaceTerminal',
    version: 1,
    kind: 'mutation',
    description:
      'Create, start, and semantically select one dedicated terminal layout rooted at the calling workspace. initialCommand is optional, at-most-once, NUL-free, and limited to 8192 UTF-8 bytes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layoutName: { type: 'string', minLength: 1, maxLength: 128 },
        terminalName: { type: 'string', minLength: 1, maxLength: 128 },
        initialCommand: { type: 'string', maxLength: MAX_INITIAL_COMMAND_BYTES }
      }
    },
    outputSchema: receipt(PANE_LAYOUT_MUTATION),
    allowedSurfaces: SURFACES,
    permission: 'panes.manage',
    scope: { kind: 'self' },
    risk: { tier: 3, label: 'persistent terminal creation' },
    declaredEffects: [
      'db.write',
      'surface.mount',
      'process.spawn',
      'shell.execute',
      UI_PRESENT,
      'ui.focus'
    ],
    validateInput: createWorkspaceTerminalInput,
    handler: (input, context) => service.createWorkspaceTerminal(input, context)
  }
  const deleteTerminalLayout: ControlDescriptor<
    {
      layoutId: string
      terminalId: string
      expectedLayoutUpdatedAt: number
      expectedTerminalUpdatedAt: number
    },
    unknown
  > = {
    id: 'panes.deleteTerminalLayout',
    version: 1,
    kind: 'mutation',
    description:
      'Delete one authorized dedicated single-terminal layout after stopping its surface.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['layoutId', 'terminalId', 'expectedLayoutUpdatedAt', 'expectedTerminalUpdatedAt'],
      properties: {
        layoutId: ID,
        terminalId: ID,
        expectedLayoutUpdatedAt: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_SAFE_REVISION
        },
        expectedTerminalUpdatedAt: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_SAFE_REVISION
        }
      }
    },
    outputSchema: receipt(PANE_LAYOUT_MUTATION),
    allowedSurfaces: SURFACES,
    permission: 'panes.manage',
    scope: { kind: 'resource', inputField: 'layoutId' },
    risk: { tier: 3, label: 'destructive pane cleanup' },
    declaredEffects: ['surface.destroy', 'process.terminate', 'db.write', 'ui.reconcile'],
    validateInput: deleteTerminalLayoutInput,
    handler: (input, context) => service.deleteTerminalLayout(input, context)
  }
  return [
    getState,
    selectTab,
    openFile,
    openDiff,
    paneDescriptor('getState'),
    paneDescriptor('selectLayout'),
    terminalDescriptor('start'),
    terminalDescriptor('stop'),
    terminalDescriptor('focus'),
    createWorkspaceTerminal,
    deleteTerminalLayout
  ] as const
}
