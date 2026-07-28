import { createHash, randomBytes, randomUUID } from 'node:crypto'

export type ClaudeRuntimeState = 'pending' | 'live'

export type ClaudeRuntimeIdentity = Readonly<{
  surfaceId: string
  workspaceId: string
  projectId: string
  claudeConversationId: string | null
  parentWorkspaceId: string | null
  forkedFromConversationId: string | null
}>

export type ClaudeRuntimeBinding = Readonly<
  ClaudeRuntimeIdentity & {
    runtimeId: string
    runtimeKind: 'claude'
    issuedAt: number
    state: ClaudeRuntimeState
    pid: number | null
  }
>

export type ClaudeRuntimeObservation = Readonly<{
  workspaceId: string
  claudeConversationId: string | null
  pid: number | null
}>

export type RuntimeLeaseIssue =
  | Readonly<{ created: true; binding: ClaudeRuntimeBinding; token: string }>
  | Readonly<{ created: false; binding: ClaudeRuntimeBinding; token: null }>

export type RuntimeLeaseRegistryOptions = Readonly<{
  now?: () => number
  generateRuntimeId?: () => string
  generateToken?: () => string
  pendingTtlMs?: number
}>

type LeaseRecord = {
  binding: ClaudeRuntimeBinding
  tokenDigest: string
}

const DEFAULT_PENDING_TTL_MS = 60_000
const MAX_GENERATION_ATTEMPTS = 32

function defaultGenerateToken(): string {
  return randomBytes(32).toString('base64url')
}

function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function sameIdentity(binding: ClaudeRuntimeBinding, identity: ClaudeRuntimeIdentity): boolean {
  return (
    binding.surfaceId === identity.surfaceId &&
    binding.workspaceId === identity.workspaceId &&
    binding.projectId === identity.projectId &&
    binding.claudeConversationId === identity.claudeConversationId &&
    binding.parentWorkspaceId === identity.parentWorkspaceId &&
    binding.forkedFromConversationId === identity.forkedFromConversationId
  )
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0) throw new Error(`Runtime lease ${field} must not be empty`)
}

function freezeBinding(
  identity: ClaudeRuntimeIdentity,
  runtimeId: string,
  issuedAt: number,
  state: ClaudeRuntimeState,
  pid: number | null
): ClaudeRuntimeBinding {
  return Object.freeze({
    ...identity,
    runtimeId,
    runtimeKind: 'claude' as const,
    issuedAt,
    state,
    pid
  })
}

/**
 * Process-local runtime attribution for Claude surfaces.
 *
 * The raw bearer token is returned only for a newly issued lease. The registry
 * stores its SHA-256 digest and never retains or exposes the secret again.
 * Reissuing an already-bound surface therefore returns `created: false` and a
 * null token; callers should retain the original launch environment rather than
 * attempting to relaunch the runtime.
 */
export class RuntimeLeaseRegistry {
  private readonly now: () => number
  private readonly generateRuntimeId: () => string
  private readonly generateToken: () => string
  private readonly pendingTtlMs: number
  private readonly byRuntimeId = new Map<string, LeaseRecord>()
  private readonly runtimeIdBySurfaceId = new Map<string, string>()
  private readonly runtimeIdsByWorkspaceId = new Map<string, Set<string>>()
  private readonly runtimeIdByTokenDigest = new Map<string, string>()
  private readonly issuedRuntimeIds = new Set<string>()
  private readonly issuedTokenDigests = new Set<string>()

  constructor(options: RuntimeLeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.generateRuntimeId = options.generateRuntimeId ?? randomUUID
    this.generateToken = options.generateToken ?? defaultGenerateToken
    this.pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS

    if (!Number.isFinite(this.pendingTtlMs) || this.pendingTtlMs <= 0) {
      throw new Error('Runtime lease pending TTL must be a positive finite number')
    }
  }

  issueOrReuseClaude(identity: ClaudeRuntimeIdentity): RuntimeLeaseIssue {
    assertNonEmpty(identity.surfaceId, 'surface id')
    assertNonEmpty(identity.workspaceId, 'workspace id')
    assertNonEmpty(identity.projectId, 'project id')

    const existingRuntimeId = this.runtimeIdBySurfaceId.get(identity.surfaceId)
    if (existingRuntimeId != null) {
      const existing = this.byRuntimeId.get(existingRuntimeId)
      if (existing == null) {
        throw new Error('Runtime lease registry index is inconsistent')
      }
      if (!sameIdentity(existing.binding, identity)) {
        throw new Error(`Runtime surface is already bound: ${identity.surfaceId}`)
      }
      return Object.freeze({ created: false, binding: existing.binding, token: null })
    }

    const runtimeId = this.createUniqueRuntimeId()
    const { token, digest } = this.createUniqueToken()
    const binding = freezeBinding(identity, runtimeId, this.now(), 'pending', null)
    const record: LeaseRecord = { binding, tokenDigest: digest }

    this.byRuntimeId.set(runtimeId, record)
    this.issuedRuntimeIds.add(runtimeId)
    this.runtimeIdBySurfaceId.set(binding.surfaceId, runtimeId)
    this.runtimeIdByTokenDigest.set(digest, runtimeId)
    this.issuedTokenDigests.add(digest)
    const workspaceRuntimeIds =
      this.runtimeIdsByWorkspaceId.get(binding.workspaceId) ?? new Set<string>()
    workspaceRuntimeIds.add(runtimeId)
    this.runtimeIdsByWorkspaceId.set(binding.workspaceId, workspaceRuntimeIds)

    return Object.freeze({ created: true, binding, token })
  }

  resolve(token: string): ClaudeRuntimeBinding | null {
    if (token.length === 0) return null
    this.sweepExpiredPendingLeases()
    const runtimeId = this.runtimeIdByTokenDigest.get(digestToken(token))
    if (runtimeId == null) return null
    return this.byRuntimeId.get(runtimeId)?.binding ?? null
  }

  getByRuntimeId(runtimeId: string): ClaudeRuntimeBinding | null {
    return this.byRuntimeId.get(runtimeId)?.binding ?? null
  }

  getBySurfaceId(surfaceId: string): ClaudeRuntimeBinding | null {
    const runtimeId = this.runtimeIdBySurfaceId.get(surfaceId)
    if (runtimeId == null) return null
    return this.byRuntimeId.get(runtimeId)?.binding ?? null
  }

  listByWorkspace(workspaceId: string): readonly ClaudeRuntimeBinding[] {
    const runtimeIds = this.runtimeIdsByWorkspaceId.get(workspaceId)
    if (runtimeIds == null) return Object.freeze([])
    return Object.freeze(
      [...runtimeIds]
        .map((runtimeId) => this.byRuntimeId.get(runtimeId)?.binding)
        .filter((binding): binding is ClaudeRuntimeBinding => binding != null)
    )
  }

  markLive(runtimeId: string, pid: number): ClaudeRuntimeBinding | null {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error('Runtime lease PID must be a positive safe integer')
    }

    const record = this.byRuntimeId.get(runtimeId)
    if (record == null) return null
    if (record.binding.state === 'live') {
      if (record.binding.pid === pid) return record.binding
      this.revokeRuntimeId(runtimeId)
      return null
    }

    record.binding = freezeBinding(record.binding, runtimeId, record.binding.issuedAt, 'live', pid)
    return record.binding
  }

  observeClaude(observation: ClaudeRuntimeObservation): ClaudeRuntimeBinding | null {
    const runtimeIds = this.runtimeIdsByWorkspaceId.get(observation.workspaceId)
    if (runtimeIds == null) return null

    for (const runtimeId of runtimeIds) {
      const record = this.byRuntimeId.get(runtimeId)
      if (record == null) continue

      if (
        record.binding.state === 'pending' &&
        record.binding.claudeConversationId == null &&
        observation.claudeConversationId != null &&
        observation.pid != null
      ) {
        record.binding = freezeBinding(
          { ...record.binding, claudeConversationId: observation.claudeConversationId },
          runtimeId,
          record.binding.issuedAt,
          'pending',
          null
        )
        return this.markLive(runtimeId, observation.pid)
      }

      if (record.binding.claudeConversationId !== observation.claudeConversationId) continue
      if (observation.pid == null) {
        if (record.binding.state === 'pending') return record.binding
        this.revokeRuntimeId(runtimeId)
        return null
      }
      return this.markLive(runtimeId, observation.pid)
    }

    return null
  }

  revokeBySurface(surfaceId: string): boolean {
    const runtimeId = this.runtimeIdBySurfaceId.get(surfaceId)
    return runtimeId == null ? false : this.revokeRuntimeId(runtimeId)
  }

  revokeByWorkspace(workspaceId: string): number {
    const runtimeIds = this.runtimeIdsByWorkspaceId.get(workspaceId)
    if (runtimeIds == null) return 0

    let revoked = 0
    for (const runtimeId of [...runtimeIds]) {
      if (this.revokeRuntimeId(runtimeId)) revoked++
    }
    return revoked
  }

  revokeAll(): number {
    const runtimeIds = [...this.byRuntimeId.keys()]
    for (const runtimeId of runtimeIds) this.revokeRuntimeId(runtimeId)
    return runtimeIds.length
  }

  sweepExpiredPendingLeases(): number {
    const cutoff = this.now() - this.pendingTtlMs
    const expiredRuntimeIds = [...this.byRuntimeId.values()]
      .filter((record) => record.binding.state === 'pending' && record.binding.issuedAt <= cutoff)
      .map((record) => record.binding.runtimeId)

    for (const runtimeId of expiredRuntimeIds) this.revokeRuntimeId(runtimeId)
    return expiredRuntimeIds.length
  }

  private revokeRuntimeId(runtimeId: string): boolean {
    const record = this.byRuntimeId.get(runtimeId)
    if (record == null) return false

    this.byRuntimeId.delete(runtimeId)
    this.runtimeIdBySurfaceId.delete(record.binding.surfaceId)
    this.runtimeIdByTokenDigest.delete(record.tokenDigest)

    const workspaceRuntimeIds = this.runtimeIdsByWorkspaceId.get(record.binding.workspaceId)
    workspaceRuntimeIds?.delete(runtimeId)
    if (workspaceRuntimeIds?.size === 0) {
      this.runtimeIdsByWorkspaceId.delete(record.binding.workspaceId)
    }
    return true
  }

  private createUniqueRuntimeId(): string {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      let runtimeId: string
      try {
        runtimeId = this.generateRuntimeId()
      } catch {
        throw new Error('Failed to generate runtime lease id')
      }
      if (runtimeId.length > 0 && !this.issuedRuntimeIds.has(runtimeId)) return runtimeId
    }
    throw new Error('Failed to generate a unique runtime lease id')
  }

  private createUniqueToken(): { token: string; digest: string } {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      let token: string
      try {
        token = this.generateToken()
      } catch {
        throw new Error('Failed to generate runtime lease token')
      }
      if (token.length === 0) continue
      const digest = digestToken(token)
      if (!this.issuedTokenDigests.has(digest)) return { token, digest }
    }
    throw new Error('Failed to generate a unique runtime lease token')
  }
}
