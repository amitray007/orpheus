import type { WorkspaceRecord } from '../../shared/types'
import type {
  ControlContext,
  ControlReadObservation,
  LastTurnReadModel,
  TranscriptReadModel,
  TrustedRuntimeBinding
} from '../controlPlane/types'
import type { ClaudeRuntimeBinding } from '../controlPlane/runtimeLeases'
import { terminalObservationError } from './errors'
import { TerminalObservationJournal } from './journal'
import type {
  AuthoritativeOutputProvider,
  ClaudeSessionMetadataModel,
  ClaudeSessionSnapshot,
  GetClaudeSessionInput,
  GetOutputTailInput,
  GetTerminalInput,
  NativeSurfacePhase,
  OutputTailModel,
  PaneTarget,
  ResolvedTerminalTarget,
  SubscribeTerminalsInput,
  TerminalConfigurationModel,
  TerminalListModel,
  TerminalObservation,
  TerminalObservationHandlers,
  TerminalSnapshot,
  TerminalSubscriptionResult,
  TerminalSummary,
  TerminalTarget
} from './types'

const MAX_LISTED_TERMINALS = 256
const DEFAULT_TRANSCRIPT_LIMIT = 20
const DEFAULT_TAIL_BYTES = 16 * 1024
const DEFAULT_TAIL_LINES = 80
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 25_000
const DEFAULT_SUBSCRIBE_EVENTS = 50
const NATIVE_SURFACE_SOURCE = 'native-surface-registry' as const
const CLAUDE_SESSION_SOURCE = 'claude-session-file' as const
const LIVE = 'live' as const
const RESOURCE_NOT_FOUND = 'Requested resource was not found.'

export type TerminalSessionInfo = {
  claudeConversationId: string | null
  pid: number | null
  version: string | null
  cwd: string | null
  status: 'busy' | 'idle' | 'waiting' | 'shell' | 'starting' | 'unknown'
  waitingFor: string | null
  statusUpdatedAt: number | null
  availability: 'available' | 'unavailable' | 'offline'
  stale: boolean
  reason?: string
}

export type PaneTerminalSnapshot = {
  layoutId: string
  paneId: string
  cwd: string
  command: string
  updatedAt: number
}

export type TerminalObservationServiceDeps = {
  now?: () => number
  listWorkspaces: (projectId: string) => WorkspaceRecord[]
  getWorkspace: (workspaceId: string) => WorkspaceRecord | null
  listWorkbenchTerminalIds: (workspaceId: string) => readonly number[]
  hasWorkbenchTerminal: (workspaceId: string, terminalId: number) => boolean
  getPaneTerminal: (layoutId: string, paneId: string) => PaneTerminalSnapshot | null
  getPaneTargetBySurfaceId: (surfaceId: string) => PaneTerminalSnapshot | null
  hasPaneSurface: (layoutId: string, paneId: string) => boolean
  getNativePhase: (surfaceId: string) => NativeSurfacePhase
  getRuntimeBySurfaceId: (surfaceId: string) => ClaudeRuntimeBinding | null
  getSessionInfo: (workspaceId: string) => TerminalSessionInfo
  isWorkspaceReady: (workspaceId: string) => boolean
  getWorkspaceActivity: (workspaceId: string) => string
  workspaceClaudeCommand: () => string
  workbenchCommand: () => string
  readTranscript: (
    workspaceId: string,
    options: { limit: number; includeToolActivity: boolean },
    context: ControlContext
  ) => Promise<ControlReadObservation<TranscriptReadModel>>
  readLastTurn: (
    workspaceId: string,
    context: ControlContext
  ) => Promise<ControlReadObservation<LastTurnReadModel>>
  outputProvider?: AuthoritativeOutputProvider
  journal?: TerminalObservationJournal
  beforeSnapshot?: () => void | Promise<void>
}

function workspaceTerminalId(workspaceId: string): string {
  return `workspace-claude/${workspaceId}`
}

function workbenchTerminalId(workspaceId: string, terminalId: number): string {
  return `workbench-terminal/${workspaceId}/${terminalId}`
}

function paneTerminalId(layoutId: string, paneId: string): string {
  return `pane-terminal/${layoutId}/${paneId}`
}

export function workbenchSurfaceId(workspaceId: string, terminalId: number): string {
  return `workbench:${workspaceId}:${terminalId}`
}

export function paneSurfaceId(layoutId: string, paneId: string): string {
  return `pane:${layoutId}:${paneId}`
}

function binding(context: ControlContext): TrustedRuntimeBinding {
  if (context.trustedRuntime == null) {
    throw terminalObservationError('forbidden', 'A trusted runtime lease is required.')
  }
  return context.trustedRuntime
}

function available<T>(
  value: T,
  source: TerminalObservation<T>['source'],
  observedAt: number,
  sourceUpdatedAt: number | null = null,
  freshness: TerminalObservation<T>['freshness'] = 'current'
): TerminalObservation<T> {
  return {
    value,
    source,
    observedAt,
    sourceUpdatedAt,
    freshness,
    availability: 'available'
  }
}

function present<T>(
  value: T,
  source: TerminalObservation<T>['source'],
  observedAt: number,
  sourceUpdatedAt: number | null,
  freshness: TerminalObservation<T>['freshness'],
  availability: 'available' | 'offline'
): TerminalObservation<T> {
  return {
    value,
    source,
    observedAt,
    sourceUpdatedAt,
    freshness,
    availability
  }
}

function absent<T>(
  source: TerminalObservation<T>['source'],
  observedAt: number,
  availability: 'unavailable' | 'unsupported' | 'offline',
  freshness: TerminalObservation<T>['freshness'],
  reason: string
): TerminalObservation<T> {
  return {
    value: null,
    source,
    observedAt,
    sourceUpdatedAt: null,
    freshness,
    availability,
    reason
  }
}

function fromControlObservation<T>(observation: ControlReadObservation<T>): TerminalObservation<T> {
  const freshness =
    observation.availability !== 'available'
      ? 'unknown'
      : observation.stale === true
        ? 'stale'
        : observation.source === LIVE || observation.source === CLAUDE_SESSION_SOURCE
          ? LIVE
          : 'current'
  return {
    value: observation.value,
    source: observation.source,
    observedAt: observation.observedAt,
    sourceUpdatedAt: observation.sourceUpdatedAt,
    freshness,
    availability: observation.availability,
    ...(observation.reason == null ? {} : { reason: observation.reason })
  }
}

function terminalSummary(target: ResolvedTerminalTarget, registered: boolean): TerminalSummary {
  return {
    terminalId: target.terminalId,
    kind: target.kind,
    workspaceId: 'workspaceId' in target ? target.workspaceId : null,
    projectId: 'projectId' in target ? target.projectId : null,
    layoutId: target.kind === 'pane' ? target.layoutId : null,
    paneId: target.kind === 'pane' ? target.paneId : null,
    surfaceRegistered: registered
  }
}

function mounted(phase: NativeSurfacePhase): boolean {
  return phase === 'hidden' || phase === 'attached' || phase === 'visible'
}

function sessionMetadata(info: TerminalSessionInfo): ClaudeSessionMetadataModel | null {
  if (info.claudeConversationId == null) return null
  return {
    claudeConversationId: info.claudeConversationId,
    pid: info.pid,
    version: info.version,
    cwd: info.cwd,
    status: info.status,
    waitingFor: info.waitingFor,
    statusUpdatedAt: info.statusUpdatedAt
  }
}

function utf8Tail(text: string, maxBytes: number): string {
  const source = Buffer.from(text, 'utf8')
  if (source.length <= maxBytes) return text
  let result = source.subarray(source.length - maxBytes).toString('utf8')
  while (Buffer.byteLength(result) > maxBytes && result.length > 0) {
    result = result.slice(1)
  }
  return result
}

export class TerminalObservationService implements TerminalObservationHandlers {
  readonly journal: TerminalObservationJournal
  private readonly now: () => number

  constructor(private readonly deps: TerminalObservationServiceDeps) {
    this.now = deps.now ?? Date.now
    this.journal = deps.journal ?? new TerminalObservationJournal(this.now)
  }

  list(context: ControlContext): TerminalObservation<TerminalListModel> {
    const observedAt = this.now()
    const runtime = binding(context)
    const targets = this.listAuthorizedTargets(runtime)
    const truncated = targets.length > MAX_LISTED_TERMINALS
    const terminals = targets.slice(0, MAX_LISTED_TERMINALS).map((target) => {
      const phase = this.safePhase(target.surfaceId)
      return terminalSummary(target, phase !== 'none')
    })
    return available({ terminals, truncated }, NATIVE_SURFACE_SOURCE, observedAt, null, LIVE)
  }

  get(input: GetTerminalInput, context: ControlContext): TerminalSnapshot {
    const target = this.resolveAuthorizedTarget(input.target, binding(context))
    return this.snapshot(target)
  }

  async getClaudeSession(
    input: GetClaudeSessionInput,
    context: ControlContext
  ): Promise<ClaudeSessionSnapshot> {
    const runtime = binding(context)
    const target = this.resolveAuthorizedTarget(
      {
        kind: 'workspace_claude',
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
      },
      runtime
    )
    if (target.kind !== 'workspace_claude') {
      throw terminalObservationError('invalid', 'Claude session target must be a workspace.')
    }
    const info = this.deps.getSessionInfo(target.workspaceId)
    const observedAt = this.now()
    const metadata = sessionMetadata(info)
    const session =
      metadata == null
        ? absent<ClaudeSessionMetadataModel>(
            CLAUDE_SESSION_SOURCE,
            observedAt,
            info.availability === 'available' ? 'unavailable' : info.availability,
            info.availability === 'offline' ? 'offline' : 'unknown',
            info.reason ?? 'Claude session metadata is unavailable.'
          )
        : {
            ...present(
              metadata,
              CLAUDE_SESSION_SOURCE,
              observedAt,
              info.statusUpdatedAt,
              info.stale ? ('stale' as const) : info.availability === 'offline' ? 'offline' : LIVE,
              info.availability === 'offline' ? 'offline' : 'available'
            ),
            ...(info.reason == null ? {} : { reason: info.reason })
          }
    const transcript = fromControlObservation(
      await this.deps.readTranscript(
        target.workspaceId,
        {
          limit: input.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT,
          includeToolActivity: input.includeToolActivity ?? false
        },
        context
      )
    )
    const lastTurn = fromControlObservation(
      await this.deps.readLastTurn(target.workspaceId, context)
    )
    return {
      schemaVersion: 1,
      workspaceId: target.workspaceId,
      session,
      transcript,
      lastTurn
    }
  }

  async getOutputTail(
    input: GetOutputTailInput,
    context: ControlContext
  ): Promise<TerminalObservation<OutputTailModel>> {
    const target = this.resolveAuthorizedTarget(input.target, binding(context))
    const observedAt = this.now()
    const provider = this.deps.outputProvider
    if (provider == null) {
      return absent(
        'authoritative-text-stream',
        observedAt,
        'unsupported',
        'unknown',
        'The current native terminal backend does not expose an authoritative text stream.'
      )
    }
    const limits = {
      maxBytes: input.maxBytes ?? DEFAULT_TAIL_BYTES,
      maxLines: input.maxLines ?? DEFAULT_TAIL_LINES
    }
    const observation = await provider.readTail(target, limits, observedAt)
    if (observation.value == null) return observation
    const inputText = observation.value.text
    const bytes = Buffer.from(inputText, 'utf8')
    const byteBounded = utf8Tail(inputText, limits.maxBytes)
    const lines = byteBounded.split('\n')
    const lineBounded =
      lines.length > limits.maxLines
        ? lines.slice(lines.length - limits.maxLines).join('\n')
        : byteBounded
    return {
      ...observation,
      value: {
        text: lineBounded,
        bytes: Buffer.byteLength(lineBounded),
        lines: lineBounded.length === 0 ? 0 : lineBounded.split('\n').length,
        truncated:
          observation.value.truncated ||
          bytes.length > limits.maxBytes ||
          lines.length > limits.maxLines
      }
    }
  }

  async subscribe(
    input: SubscribeTerminalsInput,
    context: ControlContext
  ): Promise<TerminalSubscriptionResult> {
    const runtime = binding(context)
    const target = input.target == null ? null : this.resolveAuthorizedTarget(input.target, runtime)
    const maxEvents = input.maxEvents ?? DEFAULT_SUBSCRIBE_EVENTS

    if (input.afterRevision == null) {
      return this.initialSubscription(runtime, target, maxEvents)
    }

    const terminalIds = new Set(this.subscriptionTerminalIds(runtime, target))
    let read = this.journal.read(input.afterRevision, terminalIds, maxEvents)
    if (read.overflowed) {
      return this.resyncSubscription(runtime, target, maxEvents)
    }
    if (read.events.length > 0) {
      return this.subscriptionResult(read, false, false, false, [])
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    let wakeCursor = input.afterRevision
    while (true) {
      const remainingMs = Math.max(1, deadline - Date.now())
      const wait = await this.journal.waitForChange(
        wakeCursor,
        target == null ? null : terminalIds,
        remainingMs
      )
      if (wait === 'capacity') {
        return this.subscriptionResult(read, false, false, true, [])
      }
      const refreshedTerminalIds = this.subscriptionTerminalIds(runtime, target)
      for (const terminalId of refreshedTerminalIds) terminalIds.add(terminalId)
      read = this.journal.read(input.afterRevision, terminalIds, maxEvents)
      if (read.overflowed) return this.resyncSubscription(runtime, target, maxEvents)
      if (read.events.length > 0) {
        return this.subscriptionResult(read, false, false, false, [])
      }
      if (wait === 'timeout' || Date.now() >= deadline) {
        return this.subscriptionResult(read, true, false, false, [])
      }
      wakeCursor = this.journal.currentRevision()
    }
  }

  isInputAuthorized(input: unknown, context: ControlContext): boolean {
    const runtime = context.trustedRuntime
    if (runtime == null) return false
    if (input == null || typeof input !== 'object') return false
    const record = input as Record<string, unknown>
    const target = record['target']
    const workspaceId = record['workspaceId']
    try {
      if (target !== undefined) {
        this.resolveAuthorizedTarget(target as TerminalTarget, runtime)
      } else if (typeof workspaceId === 'string') {
        this.resolveAuthorizedTarget({ kind: 'workspace_claude', workspaceId }, runtime)
      } else if (runtime.workspaceId == null && runtime.runtimeKind !== 'pane_shell') {
        return false
      }
      return true
    } catch {
      return false
    }
  }

  recordLifecycle(target: ResolvedTerminalTarget, phase: NativeSurfacePhase): void {
    this.journal.append(target.terminalId, 'lifecycle', NATIVE_SURFACE_SOURCE, {
      registered: phase !== 'none',
      phase
    })
  }

  recordWorkspaceLifecycle(workspaceId: string, phase: NativeSurfacePhase): void {
    const workspace = this.deps.getWorkspace(workspaceId)
    if (workspace == null) return
    this.recordLifecycle(this.resolveWorkspace(workspace), phase)
  }

  recordWorkbenchLifecycle(
    workspaceId: string,
    terminalId: number,
    phase: NativeSurfacePhase
  ): void {
    const workspace = this.deps.getWorkspace(workspaceId)
    if (workspace == null) return
    this.recordLifecycle(this.resolveWorkbench(workspace, terminalId), phase)
  }

  recordPaneLifecycle(layoutId: string, paneId: string, phase: NativeSurfacePhase): void {
    const pane = this.deps.getPaneTerminal(layoutId, paneId)
    if (pane == null) return
    this.recordLifecycle(this.resolvePane(pane), phase)
  }

  recordWorkspaceSession(workspaceId: string, info: TerminalSessionInfo): void {
    const workspace = this.deps.getWorkspace(workspaceId)
    if (workspace == null) return
    const metadata = sessionMetadata(info)
    this.journal.append(
      workspaceTerminalId(workspaceId),
      'runtime',
      CLAUDE_SESSION_SOURCE,
      metadata == null ? { availability: info.availability } : { ...metadata }
    )
    this.journal.append(workspaceTerminalId(workspaceId), 'readiness', CLAUDE_SESSION_SOURCE, {
      ready: this.deps.isWorkspaceReady(workspaceId)
    })
  }

  recordWorkspaceSessionFromSource(workspaceId: string): void {
    this.recordWorkspaceSession(workspaceId, this.deps.getSessionInfo(workspaceId))
  }

  recordWorkspaceActivity(workspaceId: string, activity: string): void {
    if (this.deps.getWorkspace(workspaceId) == null) return
    this.journal.append(workspaceTerminalId(workspaceId), 'activity', LIVE, { activity })
  }

  private async initialSubscription(
    runtime: TrustedRuntimeBinding,
    target: ResolvedTerminalTarget | null,
    maxEvents: number
  ): Promise<TerminalSubscriptionResult> {
    const startRevision = this.journal.currentRevision()
    await this.deps.beforeSnapshot?.()
    const snapshots = this.subscriptionSnapshots(runtime, target)
    const terminalIds = new Set(snapshots.map((entry) => entry.terminalId))
    const read = this.journal.read(startRevision, terminalIds, maxEvents)
    if (read.overflowed) return this.resyncSubscription(runtime, target, maxEvents)
    return this.subscriptionResult(read, false, false, false, snapshots)
  }

  private resyncSubscription(
    runtime: TrustedRuntimeBinding,
    target: ResolvedTerminalTarget | null,
    maxEvents: number
  ): TerminalSubscriptionResult {
    const startRevision = this.journal.currentRevision()
    const snapshots = this.subscriptionSnapshots(runtime, target)
    const terminalIds = new Set(snapshots.map((entry) => entry.terminalId))
    const read = this.journal.read(startRevision, terminalIds, maxEvents)
    return this.subscriptionResult(read, false, true, false, snapshots)
  }

  private subscriptionResult(
    read: ReturnType<TerminalObservationJournal['read']>,
    timedOut: boolean,
    resyncRequired: boolean,
    capacityLimited: boolean,
    snapshots: TerminalSubscriptionResult['snapshots']
  ): TerminalSubscriptionResult {
    return {
      schemaVersion: 1,
      cursor: read.cursor,
      oldestRevision: read.oldestRevision,
      timedOut,
      resyncRequired,
      capacityLimited,
      snapshots,
      events: read.events
    }
  }

  private subscriptionSnapshots(
    runtime: TrustedRuntimeBinding,
    target: ResolvedTerminalTarget | null
  ): TerminalSubscriptionResult['snapshots'] {
    const targets = target == null ? this.listAuthorizedTargets(runtime) : [target]
    return targets.slice(0, MAX_LISTED_TERMINALS).map((candidate) => ({
      terminalId: candidate.terminalId,
      snapshot: this.snapshot(candidate)
    }))
  }

  private subscriptionTerminalIds(
    runtime: TrustedRuntimeBinding,
    target: ResolvedTerminalTarget | null
  ): ReadonlySet<string> {
    const targets = target == null ? this.listAuthorizedTargets(runtime) : [target]
    return new Set(targets.slice(0, MAX_LISTED_TERMINALS).map((candidate) => candidate.terminalId))
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  private snapshot(target: ResolvedTerminalTarget): TerminalSnapshot {
    const observedAt = this.now()
    const phase = this.safePhase(target.surfaceId)
    const registered = phase !== 'none'
    const lifecycle = available(
      { registered, phase },
      NATIVE_SURFACE_SOURCE,
      observedAt,
      null,
      LIVE
    )
    const configuration = this.configuration(target, observedAt)

    if (target.kind !== 'workspace_claude') {
      return {
        schemaVersion: 1,
        terminal: terminalSummary(target, registered),
        lifecycle,
        runtime: available(
          {
            running: mounted(phase),
            ready: mounted(phase),
            runtimeId: null,
            pid: null
          },
          NATIVE_SURFACE_SOURCE,
          observedAt,
          null,
          LIVE
        ),
        activity: absent(
          CLAUDE_SESSION_SOURCE,
          observedAt,
          'unsupported',
          'unknown',
          'Plain terminal surfaces do not have Claude workspace activity.'
        ),
        configuration,
        claudeSession: absent(
          CLAUDE_SESSION_SOURCE,
          observedAt,
          'unsupported',
          'unknown',
          'Plain terminal surfaces do not have a Claude conversation.'
        )
      }
    }

    const workspace = this.deps.getWorkspace(target.workspaceId)
    if (workspace == null) {
      throw terminalObservationError('not_found', RESOURCE_NOT_FOUND)
    }
    const sessionInfo = this.deps.getSessionInfo(target.workspaceId)
    const runtimeBinding = this.deps.getRuntimeBySurfaceId(target.surfaceId)
    const session = sessionMetadata(sessionInfo)
    const liveStatus = sessionInfo.status === 'starting' ? 'unknown' : sessionInfo.status
    return {
      schemaVersion: 1,
      terminal: terminalSummary(target, registered),
      lifecycle,
      runtime: {
        ...present(
          {
            running:
              sessionInfo.availability === 'available'
                ? sessionInfo.pid != null
                : mounted(phase)
                  ? null
                  : false,
            ready: this.deps.isWorkspaceReady(target.workspaceId),
            runtimeId: runtimeBinding?.runtimeId ?? null,
            pid: sessionInfo.pid
          },
          session == null ? NATIVE_SURFACE_SOURCE : CLAUDE_SESSION_SOURCE,
          observedAt,
          sessionInfo.statusUpdatedAt,
          sessionInfo.stale
            ? ('stale' as const)
            : sessionInfo.availability === 'offline'
              ? ('offline' as const)
              : LIVE,
          sessionInfo.availability === 'offline' ? 'offline' : 'available'
        ),
        ...(sessionInfo.reason == null ? {} : { reason: sessionInfo.reason })
      },
      activity: present(
        {
          activity: this.deps.getWorkspaceActivity(target.workspaceId),
          persistedStatus: workspace.status,
          liveStatus:
            liveStatus === 'busy' ||
            liveStatus === 'idle' ||
            liveStatus === 'waiting' ||
            liveStatus === 'shell'
              ? liveStatus
              : 'unknown',
          waitingFor: sessionInfo.waitingFor
        },
        sessionInfo.availability === 'available' ? CLAUDE_SESSION_SOURCE : 'sqlite',
        observedAt,
        sessionInfo.statusUpdatedAt,
        sessionInfo.availability === 'available' ? LIVE : 'offline',
        sessionInfo.availability === 'available' ? 'available' : 'offline'
      ),
      configuration,
      claudeSession:
        session == null
          ? absent(
              CLAUDE_SESSION_SOURCE,
              observedAt,
              sessionInfo.availability === 'available' ? 'unavailable' : sessionInfo.availability,
              sessionInfo.availability === 'offline' ? 'offline' : 'unknown',
              sessionInfo.reason ?? 'Claude session metadata is unavailable.'
            )
          : present(
              session,
              CLAUDE_SESSION_SOURCE,
              observedAt,
              sessionInfo.statusUpdatedAt,
              sessionInfo.stale
                ? 'stale'
                : sessionInfo.availability === 'offline'
                  ? 'offline'
                  : LIVE,
              sessionInfo.availability === 'offline' ? 'offline' : 'available'
            )
    }
  }

  private configuration(
    target: ResolvedTerminalTarget,
    observedAt: number
  ): TerminalObservation<TerminalConfigurationModel> {
    if (target.kind === 'workspace_claude') {
      const workspace = this.deps.getWorkspace(target.workspaceId)
      if (workspace == null) {
        return absent(
          'sqlite',
          observedAt,
          'unavailable',
          'unknown',
          'Workspace configuration is unavailable.'
        )
      }
      const offline = this.safePhase(target.surfaceId) === 'none'
      return present(
        { command: this.deps.workspaceClaudeCommand(), cwd: workspace.cwd },
        'configured-runtime',
        observedAt,
        workspace.lastOpenedAt,
        offline ? 'offline' : 'current',
        offline ? 'offline' : 'available'
      )
    }
    if (target.kind === 'workbench') {
      const workspace = this.deps.getWorkspace(target.workspaceId)
      if (workspace == null) {
        return absent(
          'sqlite',
          observedAt,
          'unavailable',
          'unknown',
          'Workbench configuration is unavailable.'
        )
      }
      const offline = this.safePhase(target.surfaceId) === 'none'
      return present(
        { command: this.deps.workbenchCommand(), cwd: workspace.cwd },
        'configured-runtime',
        observedAt,
        workspace.lastOpenedAt,
        offline ? 'offline' : 'current',
        offline ? 'offline' : 'available'
      )
    }
    const pane = this.deps.getPaneTerminal(target.layoutId, target.paneId)
    if (pane == null) {
      return absent(
        'sqlite',
        observedAt,
        'unavailable',
        'unknown',
        'Pane terminal configuration is unavailable.'
      )
    }
    const offline = this.safePhase(target.surfaceId) === 'none'
    return present(
      { command: pane.command, cwd: pane.cwd },
      'sqlite',
      observedAt,
      pane.updatedAt,
      offline ? 'offline' : 'current',
      offline ? 'offline' : 'available'
    )
  }

  private listAuthorizedTargets(runtime: TrustedRuntimeBinding): ResolvedTerminalTarget[] {
    if (runtime.runtimeKind === 'pane_shell') {
      const pane = this.resolvePaneSelf(runtime)
      return pane == null ? [] : [pane]
    }
    if (runtime.projectId == null) return []
    const targets: ResolvedTerminalTarget[] = []
    const projectWorkspaces = this.deps
      .listWorkspaces(runtime.projectId)
      .filter((workspace) => workspace.projectId === runtime.projectId)
    const selfWorkspace =
      runtime.workspaceId == null
        ? null
        : (projectWorkspaces.find((workspace) => workspace.id === runtime.workspaceId) ?? null)
    const orderedWorkspaces =
      selfWorkspace == null
        ? projectWorkspaces
        : [
            selfWorkspace,
            ...projectWorkspaces.filter((workspace) => workspace.id !== selfWorkspace.id)
          ]
    for (const workspace of orderedWorkspaces) {
      if (workspace.projectId !== runtime.projectId) continue
      targets.push(this.resolveWorkspace(workspace))
      if (targets.length > MAX_LISTED_TERMINALS) return targets
      for (const terminalId of this.deps.listWorkbenchTerminalIds(workspace.id)) {
        targets.push(this.resolveWorkbench(workspace, terminalId))
        if (targets.length > MAX_LISTED_TERMINALS) return targets
      }
    }
    return targets
  }

  private resolveAuthorizedTarget(
    target: TerminalTarget | undefined,
    runtime: TrustedRuntimeBinding
  ): ResolvedTerminalTarget {
    const effectiveTarget =
      target ??
      (runtime.runtimeKind === 'pane_shell'
        ? this.targetForPaneSelf(runtime)
        : {
            kind: 'workspace_claude',
            ...(runtime.workspaceId ? { workspaceId: runtime.workspaceId } : {})
          })
    if (effectiveTarget == null) {
      throw terminalObservationError('not_found', RESOURCE_NOT_FOUND)
    }
    if (effectiveTarget.kind === 'pane') {
      const pane = this.deps.getPaneTerminal(effectiveTarget.layoutId, effectiveTarget.paneId)
      if (pane == null) {
        throw terminalObservationError('not_found', RESOURCE_NOT_FOUND)
      }
      const resolved = this.resolvePane(pane)
      if (
        runtime.runtimeKind !== 'pane_shell' ||
        runtime.surfaceId !== resolved.surfaceId ||
        !this.deps.hasPaneSurface(pane.layoutId, pane.paneId)
      ) {
        throw terminalObservationError('not_found', RESOURCE_NOT_FOUND)
      }
      return resolved
    }
    const workspaceId =
      effectiveTarget.kind === 'workspace_claude'
        ? (effectiveTarget.workspaceId ?? runtime.workspaceId)
        : effectiveTarget.workspaceId
    if (workspaceId == null || runtime.projectId == null) {
      throw terminalObservationError('not_found', RESOURCE_NOT_FOUND)
    }
    const workspace = this.deps.getWorkspace(workspaceId)
    if (workspace == null || workspace.projectId !== runtime.projectId) {
      throw terminalObservationError('not_found', RESOURCE_NOT_FOUND)
    }
    if (effectiveTarget.kind === 'workbench') {
      if (!this.deps.hasWorkbenchTerminal(workspace.id, effectiveTarget.terminalId)) {
        throw terminalObservationError('not_found', RESOURCE_NOT_FOUND)
      }
      return this.resolveWorkbench(workspace, effectiveTarget.terminalId)
    }
    return this.resolveWorkspace(workspace)
  }

  private resolveWorkspace(workspace: WorkspaceRecord): ResolvedTerminalTarget {
    return {
      kind: 'workspace_claude',
      terminalId: workspaceTerminalId(workspace.id),
      surfaceId: workspace.id,
      workspaceId: workspace.id,
      projectId: workspace.projectId
    }
  }

  private resolveWorkbench(workspace: WorkspaceRecord, terminalId: number): ResolvedTerminalTarget {
    return {
      kind: 'workbench',
      terminalId: workbenchTerminalId(workspace.id, terminalId),
      surfaceId: workbenchSurfaceId(workspace.id, terminalId),
      workspaceId: workspace.id,
      projectId: workspace.projectId,
      workbenchTerminalId: terminalId
    }
  }

  private resolvePane(pane: PaneTerminalSnapshot): ResolvedTerminalTarget {
    return {
      kind: 'pane',
      terminalId: paneTerminalId(pane.layoutId, pane.paneId),
      surfaceId: paneSurfaceId(pane.layoutId, pane.paneId),
      layoutId: pane.layoutId,
      paneId: pane.paneId
    }
  }

  private targetForPaneSelf(runtime: TrustedRuntimeBinding): PaneTarget | null {
    const pane = this.resolvePaneSelf(runtime)
    return pane == null || pane.kind !== 'pane'
      ? null
      : { kind: 'pane', layoutId: pane.layoutId, paneId: pane.paneId }
  }

  private resolvePaneSelf(runtime: TrustedRuntimeBinding): ResolvedTerminalTarget | null {
    if (runtime.runtimeKind !== 'pane_shell') return null
    // The persisted pane/native registries are the authority. Main compares
    // exact known surface ids and never parses the opaque trusted surface id.
    const pane = this.deps.getPaneTargetBySurfaceId(runtime.surfaceId)
    return pane == null || !this.deps.hasPaneSurface(pane.layoutId, pane.paneId)
      ? null
      : this.resolvePane(pane)
  }

  private safePhase(surfaceId: string): NativeSurfacePhase {
    try {
      return this.deps.getNativePhase(surfaceId)
    } catch {
      return 'none'
    }
  }
}

export function createTerminalObservationHandlers(
  service: TerminalObservationService
): TerminalObservationHandlers {
  return {
    list: (context) => service.list(context),
    get: (input, context) => service.get(input, context),
    getClaudeSession: (input, context) => service.getClaudeSession(input, context),
    getOutputTail: (input, context) => service.getOutputTail(input, context),
    subscribe: (input, context) => service.subscribe(input, context)
  }
}
