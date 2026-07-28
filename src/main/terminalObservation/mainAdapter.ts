import { app } from 'electron'
import * as path from 'node:path'
import type { ReadCapabilityHandlers } from '../controlPlane/types'
import type { RuntimeLeaseRegistry } from '../controlPlane/runtimeLeases'
import { getLiveSessionState, getWorkspaceFileInfo } from '../sessionState'
import { getWorkspaceActivity, onWorkspaceStatusChange } from '../orpheusNotify'
import { getLayout, listTerminals } from '../paneStore'
import { getAddonRef } from '../actions/addonSurface'
import type { GhosttySurfaceAddon } from '../../../packages/ghostty-surface/index'
import type { NativeSurfacePhase } from './types'
import { createNativeOutputProvider } from './nativeOutputProvider'
import {
  TerminalObservationService,
  type PaneTerminalSnapshot,
  type TerminalObservationServiceDeps,
  type TerminalSessionInfo
} from './service'

export type MainTerminalObservationDeps = {
  runtimeLeases: RuntimeLeaseRegistry
  reads: ReadCapabilityHandlers
  listWorkspaces: TerminalObservationServiceDeps['listWorkspaces']
  getWorkspace: TerminalObservationServiceDeps['getWorkspace']
  listWorkbenchTerminalIds: TerminalObservationServiceDeps['listWorkbenchTerminalIds']
  hasWorkbenchTerminal: TerminalObservationServiceDeps['hasWorkbenchTerminal']
  hasPaneSurface: TerminalObservationServiceDeps['hasPaneSurface']
  getPaneTargetBySurfaceId: TerminalObservationServiceDeps['getPaneTargetBySurfaceId']
  getNativePhase: (surfaceId: string) => NativeSurfacePhase
}

function workspaceClaudeCommand(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'orpheus-claude.sh')
    : path.join(__dirname, '../../resources/orpheus-claude.sh')
}

function getPaneTerminal(layoutId: string, paneId: string): PaneTerminalSnapshot | null {
  const layout = getLayout(layoutId)
  if (layout == null) return null
  const terminal = listTerminals(layoutId).find((candidate) => candidate.id === paneId)
  if (terminal == null) return null
  return {
    layoutId,
    paneId,
    cwd: layout.dir,
    command: terminal.command,
    updatedAt: Math.max(layout.updatedAt, terminal.updatedAt)
  }
}

function sessionInfo(
  workspaceId: string,
  getWorkspace: MainTerminalObservationDeps['getWorkspace']
): TerminalSessionInfo {
  const workspace = getWorkspace(workspaceId)
  if (workspace?.claudeSessionId == null) {
    return {
      claudeConversationId: null,
      pid: null,
      version: null,
      cwd: null,
      status: 'unknown',
      waitingFor: null,
      statusUpdatedAt: null,
      availability: 'unavailable',
      stale: false,
      reason: 'Workspace has no Claude conversation.'
    }
  }
  const live = getLiveSessionState().get(workspace.claudeSessionId)
  const file = getWorkspaceFileInfo(workspaceId)
  if (live == null || file.availability === 'unavailable') {
    return {
      claudeConversationId: workspace.claudeSessionId,
      pid: null,
      version: live?.version ?? null,
      cwd: live?.cwd ?? null,
      status: live?.status == null && live != null ? 'starting' : 'unknown',
      waitingFor: live?.waitingFor ?? null,
      statusUpdatedAt: live?.statusUpdatedAt ?? null,
      availability: 'offline',
      stale: live != null,
      reason:
        live == null
          ? 'Claude runtime is offline.'
          : 'Last observed Claude session metadata is stale.'
    }
  }
  return {
    claudeConversationId: workspace.claudeSessionId,
    pid: live?.pid ?? null,
    version: live?.version ?? null,
    cwd: live?.cwd ?? null,
    status: live?.status ?? 'starting',
    waitingFor: file.waitingFor ?? live?.waitingFor ?? null,
    statusUpdatedAt: file.statusUpdatedAt ?? live?.statusUpdatedAt ?? null,
    availability: 'available',
    stale: false
  }
}

export function createMainTerminalObservation(deps: MainTerminalObservationDeps): {
  service: TerminalObservationService
  dispose: () => void
} {
  const service = new TerminalObservationService({
    listWorkspaces: deps.listWorkspaces,
    getWorkspace: deps.getWorkspace,
    listWorkbenchTerminalIds: deps.listWorkbenchTerminalIds,
    hasWorkbenchTerminal: deps.hasWorkbenchTerminal,
    getPaneTerminal,
    getPaneTargetBySurfaceId: deps.getPaneTargetBySurfaceId,
    hasPaneSurface: deps.hasPaneSurface,
    getNativePhase: deps.getNativePhase,
    getRuntimeBySurfaceId: (surfaceId) => deps.runtimeLeases.getBySurfaceId(surfaceId),
    getSessionInfo: (workspaceId) => sessionInfo(workspaceId, deps.getWorkspace),
    isWorkspaceReady: (workspaceId) => {
      const info = getWorkspaceFileInfo(workspaceId)
      return (
        info.availability === 'available' &&
        (info.status === 'busy' ||
          info.status === 'idle' ||
          info.status === 'waiting' ||
          info.status === 'shell')
      )
    },
    getWorkspaceActivity,
    workspaceClaudeCommand,
    workbenchCommand: () => process.env['SHELL'] || '/bin/zsh',
    outputProvider: createNativeOutputProvider(
      () => getAddonRef() as Pick<GhosttySurfaceAddon, 'readScreenTail'> | null
    ),
    readTranscript: (workspaceId, options, context) =>
      Promise.resolve(
        deps.reads.getWorkspaceTranscript(
          workspaceId,
          {
            limit: options.limit,
            includeToolActivity: options.includeToolActivity
          },
          context
        )
      ),
    readLastTurn: (workspaceId, context) =>
      Promise.resolve(deps.reads.getWorkspaceLastTurn(workspaceId, context))
  })
  const unsubscribeActivity = onWorkspaceStatusChange((workspaceId, _oldStatus, newStatus) => {
    service.recordWorkspaceActivity(workspaceId, newStatus)
  })
  return {
    service,
    dispose: () => {
      unsubscribeActivity()
      service.journal.dispose()
    }
  }
}
