import type { OverlayDescriptor } from '@shared/types'
import { DevTest } from './kinds/DevTest'
import { HoverCard } from './kinds/HoverCard'
import { DetailsCard } from './kinds/DetailsCard'
import { ProjectCard } from './kinds/ProjectCard'
import { ConfirmModal } from './kinds/ConfirmModal'
import { NoticeBanner } from './kinds/NoticeBanner'
import { ChipTooltip } from './kinds/ChipTooltip'
import { ChipPrompt } from './kinds/ChipPrompt'
import { ChipDropdown } from './kinds/ChipDropdown'
import { WorkspaceSettingsCard } from './kinds/WorkspaceSettingsCard'

export interface OverlayKindProps {
  descriptor: OverlayDescriptor
  props: Record<string, unknown>
  /** Sends an `overlay:event` back to main with overlayId/kind already filled in. */
  emit: (type: string, payload?: Record<string, unknown>) => void
}

/** kind -> component. Unknown kinds are handled by OverlayRoot (error card + ack error). */
export const registry: Record<string, React.ComponentType<OverlayKindProps>> = {
  devTest: DevTest,
  hoverCard: HoverCard,
  detailsCard: DetailsCard,
  projectCard: ProjectCard,
  confirmModal: ConfirmModal,
  noticeBanner: NoticeBanner,
  chipTooltip: ChipTooltip,
  chipPrompt: ChipPrompt,
  chipDropdown: ChipDropdown,
  workspaceSettingsCard: WorkspaceSettingsCard
}
