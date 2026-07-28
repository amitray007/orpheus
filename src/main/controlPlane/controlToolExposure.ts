import type {
  ControlToolCategory,
  ControlToolsReset,
  ControlToolsSettings,
  ControlToolsUpdate
} from '../../shared/types'
import type { DbLike } from '../db/types'
import type {
  ControlAuthorizationDecision,
  ControlAuthorizationPolicy,
  ControlDescription
} from './types'

type PreferenceRow = {
  id: string
  enabled: number
  updated_at: number
}

export type ControlCatalogWaitResult = Readonly<{
  revision: number
  changed: boolean
}>

type CatalogWaiter = {
  resolve: (result: ControlCatalogWaitResult) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

const CATEGORY_DEFINITIONS = Object.freeze([
  { id: 'identity', label: 'Identity' },
  { id: 'projects', label: 'Projects' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'reviews', label: 'Reviews' },
  { id: 'workbench', label: 'Workbench' },
  { id: 'panes', label: 'Panes' },
  { id: 'terminals', label: 'Terminals' },
  { id: 'automations', label: 'Automations' },
  { id: 'settings', label: 'Settings' },
  { id: 'resources', label: 'Resources' }
] as const satisfies readonly { id: ControlToolCategory; label: string }[])

const CATEGORY_IDS = new Set<ControlToolCategory>(
  CATEGORY_DEFINITIONS.map((category) => category.id)
)

function categoryForOperation(operationId: string): ControlToolCategory {
  if (operationId === 'self.get') return 'identity'
  const prefix = operationId.split('.', 1)[0]
  return CATEGORY_IDS.has(prefix as ControlToolCategory)
    ? (prefix as ControlToolCategory)
    : 'resources'
}

function boolPreference(row: PreferenceRow | undefined): boolean | null {
  return row == null ? null : row.enabled === 1
}

function preferenceMap(rows: PreferenceRow[]): Map<string, PreferenceRow> {
  return new Map(rows.map((row) => [row.id, row]))
}

function maxUpdatedAt(...maps: Map<string, PreferenceRow>[]): number | null {
  let latest: number | null = null
  for (const map of maps) {
    for (const row of map.values()) {
      if (latest == null || row.updated_at > latest) latest = row.updated_at
    }
  }
  return latest
}

export class ControlToolExposureStore {
  private catalogRevision = 1
  private readonly catalogWaiters = new Set<CatalogWaiter>()
  private descriptions: readonly ControlDescription[] | null = null
  private readonly categoryPreferences: Map<string, PreferenceRow>
  private readonly toolPreferences: Map<string, PreferenceRow>

  constructor(
    private readonly db: DbLike,
    private readonly listDescriptions: () => readonly ControlDescription[],
    private readonly now: () => number = Date.now
  ) {
    this.categoryPreferences = preferenceMap(
      (
        this.db
          .prepare(
            'SELECT category_id AS id, enabled, updated_at FROM control_tool_category_preferences'
          )
          .all() as PreferenceRow[]
      ).filter((row) => CATEGORY_IDS.has(row.id as ControlToolCategory))
    )
    this.toolPreferences = preferenceMap(
      this.db
        .prepare('SELECT operation_id AS id, enabled, updated_at FROM control_tool_preferences')
        .all() as PreferenceRow[]
    )
  }

  /**
   * Capture the immutable MCP catalog only after the global control registry
   * has been configured and booted. Construction happens before configuration
   * so the exposure policy can participate in that boot; eagerly listing here
   * would instantiate the compatibility registry and make configuration fail.
   *
   * The method remains lazy/idempotent for focused consumers that do not use
   * the main-process lifecycle owner.
   */
  initializeDescriptions(): void {
    if (this.descriptions != null) return
    const descriptions = Object.freeze(
      [...this.listDescriptions()]
        .filter((description) => description.allowedSurfaces.includes('mcp'))
        .sort((a, b) => a.id.localeCompare(b.id))
    )
    const operationIds = new Set(descriptions.map((description) => description.id))
    for (const operationId of this.toolPreferences.keys()) {
      if (!operationIds.has(operationId)) this.toolPreferences.delete(operationId)
    }
    this.descriptions = descriptions
  }

  isEnabled(operationId: string): boolean {
    const category = categoryForOperation(operationId)
    const categoryRow = this.categoryPreferences.get(category)
    if (categoryRow?.enabled === 0) return false
    const toolRow = this.toolPreferences.get(operationId)
    return toolRow?.enabled !== 0
  }

  get(): ControlToolsSettings {
    const descriptions = this.mcpDescriptions()
    const categoryRows = this.categoryPreferences
    const toolRows = this.toolPreferences
    const toolCounts = new Map<ControlToolCategory, number>()
    for (const description of descriptions) {
      const category = categoryForOperation(description.id)
      toolCounts.set(category, (toolCounts.get(category) ?? 0) + 1)
    }

    const categories = CATEGORY_DEFINITIONS.map(({ id, label }) => {
      const override = boolPreference(categoryRows.get(id))
      return {
        id,
        label,
        enabled: override ?? true,
        override,
        toolCount: toolCounts.get(id) ?? 0
      }
    })
    const categoryEnabled = new Map(categories.map((category) => [category.id, category.enabled]))
    const tools = descriptions.map((description) => {
      const category = categoryForOperation(description.id)
      const override = boolPreference(toolRows.get(description.id))
      const enabledByCategory = categoryEnabled.get(category) ?? true
      return {
        id: description.id,
        category,
        description: description.description,
        kind: description.kind,
        riskTier: description.risk.tier,
        enabled: enabledByCategory && (override ?? true),
        categoryEnabled: enabledByCategory,
        override
      }
    })
    return {
      categories,
      tools,
      updatedAt: maxUpdatedAt(categoryRows, toolRows)
    }
  }

  update(update: ControlToolsUpdate): ControlToolsSettings {
    const before = this.exposureSnapshot()
    const updatedAt = this.now()
    if (update.target === 'category') {
      this.assertCategory(update.id)
      this.db
        .prepare(
          `INSERT INTO control_tool_category_preferences (category_id, enabled, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(category_id) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`
        )
        .run(update.id, update.enabled ? 1 : 0, updatedAt)
      this.categoryPreferences.set(update.id, {
        id: update.id,
        enabled: update.enabled ? 1 : 0,
        updated_at: updatedAt
      })
    } else {
      this.assertOperation(update.id)
      this.db
        .prepare(
          `INSERT INTO control_tool_preferences (operation_id, enabled, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(operation_id) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`
        )
        .run(update.id, update.enabled ? 1 : 0, updatedAt)
      this.toolPreferences.set(update.id, {
        id: update.id,
        enabled: update.enabled ? 1 : 0,
        updated_at: updatedAt
      })
    }
    this.bumpRevisionIfChanged(before)
    return this.get()
  }

  reset(reset: ControlToolsReset): ControlToolsSettings {
    const before = this.exposureSnapshot()
    if (reset.target === 'all') {
      this.db.exec(
        'DELETE FROM control_tool_preferences; DELETE FROM control_tool_category_preferences'
      )
      this.categoryPreferences.clear()
      this.toolPreferences.clear()
    } else if (reset.target === 'category') {
      this.assertCategory(reset.id)
      this.db
        .prepare('DELETE FROM control_tool_category_preferences WHERE category_id = ?')
        .run(reset.id)
      this.categoryPreferences.delete(reset.id)
    } else {
      this.assertOperation(reset.id)
      this.db.prepare('DELETE FROM control_tool_preferences WHERE operation_id = ?').run(reset.id)
      this.toolPreferences.delete(reset.id)
    }
    this.bumpRevisionIfChanged(before)
    return this.get()
  }

  getCatalogRevision(): number {
    return this.catalogRevision
  }

  waitForCatalogRevision(
    afterRevision: number,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ControlCatalogWaitResult> {
    if (
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 1 ||
      afterRevision > this.catalogRevision
    ) {
      return Promise.reject(new Error('Control catalog revision is invalid.'))
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new Error('Control catalog wait timeout is invalid.'))
    }
    if (afterRevision < this.catalogRevision) {
      return Promise.resolve({ revision: this.catalogRevision, changed: true })
    }
    if (signal?.aborted === true) {
      return Promise.reject(new Error('Control catalog wait was aborted.'))
    }

    return new Promise<ControlCatalogWaitResult>((resolve, reject) => {
      const waiter: CatalogWaiter = {
        resolve: (result) => {
          this.removeWaiter(waiter)
          resolve(result)
        },
        timer: setTimeout(() => {
          this.removeWaiter(waiter)
          resolve({ revision: this.catalogRevision, changed: false })
        }, timeoutMs),
        signal
      }
      waiter.timer.unref?.()
      if (signal != null) {
        waiter.onAbort = () => {
          this.removeWaiter(waiter)
          reject(new Error('Control catalog wait was aborted.'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.catalogWaiters.add(waiter)

      // Keep the subscription safe if preference persistence becomes async.
      if (afterRevision < this.catalogRevision) {
        waiter.resolve({ revision: this.catalogRevision, changed: true })
      }
    })
  }

  private assertCategory(category: ControlToolCategory): void {
    if (!CATEGORY_IDS.has(category)) throw new Error(`Unknown control tool category: ${category}`)
  }

  private assertOperation(operationId: string): void {
    if (!this.mcpDescriptions().some((description) => description.id === operationId)) {
      throw new Error(`Unknown control tool: ${operationId}`)
    }
  }

  private mcpDescriptions(): ControlDescription[] {
    this.initializeDescriptions()
    return [...(this.descriptions ?? [])]
  }

  private exposureSnapshot(): string {
    return this.mcpDescriptions()
      .map((description) => `${description.id}:${this.isEnabled(description.id) ? '1' : '0'}`)
      .join('\n')
  }

  private bumpRevisionIfChanged(before: string): void {
    if (before === this.exposureSnapshot()) return
    this.catalogRevision++
    const result = { revision: this.catalogRevision, changed: true } as const
    for (const waiter of [...this.catalogWaiters]) waiter.resolve(result)
  }

  private removeWaiter(waiter: CatalogWaiter): void {
    if (!this.catalogWaiters.delete(waiter)) return
    clearTimeout(waiter.timer)
    if (waiter.signal != null && waiter.onAbort != null) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }
}

function disabled(): ControlAuthorizationDecision {
  return {
    allowed: false,
    code: 'forbidden',
    error: 'This Orpheus control tool is disabled in Settings.'
  }
}

/**
 * Exposure is an MCP publication boundary, not an app permission prompt.
 * Renderer, command-socket, and automation behavior is unchanged. Invocation
 * checks the exact operation after the base authorization resolves, making
 * the persisted toggle the final check before the handler can mutate state.
 */
export function withControlToolExposurePolicy(
  base: ControlAuthorizationPolicy,
  exposure: Pick<ControlToolExposureStore, 'isEnabled'>
): ControlAuthorizationPolicy {
  const enabled = (operationId: string): boolean => {
    try {
      return exposure.isEnabled(operationId)
    } catch {
      return false
    }
  }
  return {
    canDiscover(description, context) {
      if (context.consumer === 'mcp' && !enabled(description.id)) return false
      return base.canDiscover(description, context)
    },
    async authorize(description, input, context) {
      const decision = await base.authorize(description, input, context)
      if (!decision.allowed || context.consumer !== 'mcp') return decision
      return enabled(description.id) ? decision : disabled()
    }
  }
}

export { CATEGORY_DEFINITIONS, categoryForOperation }
