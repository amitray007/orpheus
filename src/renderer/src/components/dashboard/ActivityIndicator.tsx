import type React from 'react'
import { Circle, CircleDashed, Diamond } from '@phosphor-icons/react'
import type { WorkspaceActivityDetail } from '@shared/types'
import { BRAILLE_FRAMES } from '@/lib/braille'
import { useSharedFrame } from '@/lib/sharedTicker'

const TOOL_FRAMES = ['◐', '◓', '◑', '◒'] as const
const COMPACT_FRAMES = [
  '▁',
  '▂',
  '▃',
  '▄',
  '▅',
  '▆',
  '▇',
  '█',
  '▇',
  '▆',
  '▅',
  '▄',
  '▃',
  '▂'
] as const

interface ActivityIndicatorProps {
  detail: WorkspaceActivityDetail | undefined
  className?: string
  /** When false all ticker subscriptions are disabled and a static frame-0
   *  glyph is rendered. Use for decorative / column-header contexts where the
   *  animation serves no informational purpose. Defaults to true. */
  animated?: boolean
}

// Fixed 12×12 box with flex centering so SVG and text content share an
// identical bounding box and visual center — matches PrChip's icon variant
// container so siblings in a sidebar / kanban row land on the same line.
const BASE_CLS = 'inline-flex items-center justify-center flex-shrink-0 leading-none w-3 h-3'

export function ActivityIndicator({
  detail,
  className,
  animated = true
}: ActivityIndicatorProps): React.JSX.Element | null {
  // useSharedFrame shares ONE interval per distinct ms across all mounted indicators.
  // When active=false no interval is registered and frame stays 0.
  // animated=false forces active=false for every ticker so static headers never
  // create a subscription (the 80ms interval stops when subscriber count hits 0).
  const brailleFrame = useSharedFrame(80, animated && detail === 'thinking')
  const toolFrame = useSharedFrame(200, animated && detail === 'tool')
  const compactFrame = useSharedFrame(100, animated && detail === 'compacting')

  if (!detail || detail === 'archived') return null

  const cls = className ? `${BASE_CLS} ${className}` : BASE_CLS

  // Static states use SVG glyphs so they centre geometrically. Text glyphs
  // (like U+25CF '●') sit at the font's baseline / cap-height position,
  // which is offset from the line-box centre — they end up visually lower
  // than an SVG sibling in the same flex row.
  if (detail === 'ready') {
    return (
      <span className={`${cls} text-emerald-400`}>
        <Circle size={11} weight="fill" />
      </span>
    )
  }
  if (detail === 'idle') {
    return (
      <span className={`${cls} text-text-muted`}>
        <CircleDashed size={11} weight="bold" />
      </span>
    )
  }
  if (detail === 'attention') {
    return (
      <span className={`${cls} text-amber-400${animated ? ' animate-pulse' : ''}`}>
        <Diamond size={11} weight="fill" />
      </span>
    )
  }
  // Animated states stay text-rendered — the frames are unicode sequences.
  if (detail === 'thinking') {
    return (
      <span className={`${cls} text-accent text-xs font-mono`}>
        {BRAILLE_FRAMES[brailleFrame % BRAILLE_FRAMES.length]}
      </span>
    )
  }
  if (detail === 'tool') {
    return (
      <span className={`${cls} text-accent text-xs font-mono`}>
        {TOOL_FRAMES[toolFrame % TOOL_FRAMES.length]}
      </span>
    )
  }
  if (detail === 'compacting') {
    return (
      <span className={`${cls} text-accent text-xs font-mono`}>
        {COMPACT_FRAMES[compactFrame % COMPACT_FRAMES.length]}
      </span>
    )
  }
  if (detail === 'asking') {
    return (
      <span
        className={`${cls} text-amber-400 text-xs font-mono font-bold${animated ? ' animate-pulse' : ''}`}
      >
        ?
      </span>
    )
  }
  return null
}
