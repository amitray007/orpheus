import { createReviewCapabilities } from './reviewCapabilities'
import type { ControlRegistry } from './registry'
import type { ReviewCapabilityHandlers } from './types'

export function bootControlRegistry(
  registry: ControlRegistry,
  handlers: ReviewCapabilityHandlers
): void {
  const [listCapability, setResolvedCapability] = createReviewCapabilities(handlers)
  registry.register(listCapability)
  registry.register(setResolvedCapability)
}
