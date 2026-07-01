import type { OverlayDescriptor } from '@shared/types'
import { DevTest } from './kinds/DevTest'

export interface OverlayKindProps {
  descriptor: OverlayDescriptor
  props: Record<string, unknown>
  /** Sends an `overlay:event` back to main with overlayId/kind already filled in. */
  emit: (type: string, payload?: Record<string, unknown>) => void
}

/** kind -> component. Unknown kinds are handled by OverlayRoot (error card + ack error). */
export const registry: Record<string, React.ComponentType<OverlayKindProps>> = {
  devTest: DevTest
}
