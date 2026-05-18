import { useEffect, useState } from 'react'
import type React from 'react'
import { Circle, CircleDashed, Diamond } from '@phosphor-icons/react'
import type { WorkspaceActivityDetail } from '@shared/types'

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
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

function useAnimatedFrame(frames: readonly string[], intervalMs: number, active: boolean): string {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setIndex((i) => (i + 1) % frames.length), intervalMs)
    return () => clearInterval(id)
  }, [frames, intervalMs, active])
  return frames[index] ?? frames[0] ?? ''
}

interface ActivityIndicatorProps {
  detail: WorkspaceActivityDetail | undefined
  className?: string
}

// Fixed 12×12 box with flex centering so SVG and text content share an
// identical bounding box and visual center — matches PrChip's icon variant
// container so siblings in a sidebar / kanban row land on the same line.
const BASE_CLS = 'inline-flex items-center justify-center flex-shrink-0 leading-none w-3 h-3'

export function ActivityIndicator({
  detail,
  className
}: ActivityIndicatorProps): React.JSX.Element | null {
  const braille = useAnimatedFrame(BRAILLE_FRAMES, 80, detail === 'thinking')
  const tool = useAnimatedFrame(TOOL_FRAMES, 200, detail === 'tool')
  const compact = useAnimatedFrame(COMPACT_FRAMES, 100, detail === 'compacting')

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
      <span className={`${cls} text-amber-400 animate-pulse`}>
        <Diamond size={11} weight="fill" />
      </span>
    )
  }
  // Animated states stay text-rendered — the frames are unicode sequences.
  if (detail === 'thinking') {
    return <span className={`${cls} text-accent text-xs font-mono`}>{braille}</span>
  }
  if (detail === 'tool') {
    return <span className={`${cls} text-accent text-xs font-mono`}>{tool}</span>
  }
  if (detail === 'compacting') {
    return <span className={`${cls} text-accent text-xs font-mono`}>{compact}</span>
  }
  if (detail === 'asking') {
    return (
      <span className={`${cls} text-amber-400 text-xs font-mono font-bold animate-pulse`}>?</span>
    )
  }
  return null
}
