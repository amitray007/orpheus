import type { DbLike } from '../db/types'
import { AutomationGrantPolicy, type AutomationGrantSource } from '../controlPlane/automationPolicy'
import type { AutomationRegistry } from './types'
import { createAutomationAuditStore } from './audit'
import { AutomationScheduler } from './scheduler'
import { AutomationService } from './service'
import { createAutomationStore } from './store'

export function createAutomationRuntime(config: {
  db: DbLike
  registry: AutomationRegistry
  grants?: AutomationGrantSource
  allowedEventTypes?: ReadonlySet<string>
  now?: () => number
  generateId?: () => string
}): { service: AutomationService; scheduler: AutomationScheduler } {
  const store = createAutomationStore(config.db)
  const audit = createAutomationAuditStore(config.db)
  const service = new AutomationService({
    store,
    registry: config.registry,
    grants: new AutomationGrantPolicy(config.grants),
    audit,
    allowedEventTypes: config.allowedEventTypes ?? new Set(),
    now: config.now,
    generateId: config.generateId
  })
  return {
    service,
    scheduler: new AutomationScheduler({
      store,
      service,
      registry: config.registry,
      audit,
      generateId: config.generateId
    })
  }
}

export { AutomationScheduler } from './scheduler'
export { AutomationService, AutomationDefinitionError } from './service'
export { createAutomationStore } from './store'
export { persistableAutomationResult } from './resultPersistence'
export { AUTOMATION_DEFAULTS, AUTOMATION_LIMITS } from './types'
export type * from './types'
