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

  constructor(
    private readonly db: DbLike,
    private readonly listDescriptions: () => readonly ControlDescription[],
    private readonly now: () => number = Date.now
  ) {}

  isEnabled(operationId: string): boolean {
    const category = categoryForOperation(operationId)
    const categoryRow = this.db
      .prepare('SELECT enabled FROM control_tool_category_preferences WHERE category_id = ?')
      .get(category) as Pick<PreferenceRow, 'enabled'> | undefined
    if (categoryRow?.enabled === 0) return false
    const toolRow = this.db
      .prepare('SELECT enabled FROM control_tool_preferences WHERE operation_id = ?')
      .get(operationId) as Pick<PreferenceRow, 'enabled'> | undefined
    return toolRow?.enabled !== 0
  }

  get(): ControlToolsSettings {
    const descriptions = this.mcpDescriptions()
    const categoryRows = preferenceMap(
      this.db
        .prepare(
          'SELECT category_id AS id, enabled, updated_at FROM control_tool_category_preferences'
        )
        .all() as PreferenceRow[]
    )
    const toolRows = preferenceMap(
      this.db
        .prepare('SELECT operation_id AS id, enabled, updated_at FROM control_tool_preferences')
        .all() as PreferenceRow[]
    )
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
        .run(update.id, update.enabled ? 1 : 0, this.now())
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
        .run(update.id, update.enabled ? 1 : 0, this.now())
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
    } else if (reset.target === 'category') {
      this.assertCategory(reset.id)
      this.db
        .prepare('DELETE FROM control_tool_category_preferences WHERE category_id = ?')
        .run(reset.id)
    } else {
      this.assertOperation(reset.id)
      this.db.prepare('DELETE FROM control_tool_preferences WHERE operation_id = ?').run(reset.id)
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
    return [...this.listDescriptions()]
      .filter((description) => description.allowedSurfaces.includes('mcp'))
      .sort((a, b) => a.id.localeCompare(b.id))
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
