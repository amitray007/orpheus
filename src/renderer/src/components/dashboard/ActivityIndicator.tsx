import { useEffect, useState } from 'react'
import type React from 'react'
import type { WorkspaceActivityDetail } from '@shared/types'

const BRAILLE_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'] as const
const TOOL_FRAMES = ['◐','◓','◑','◒'] as const
const COMPACT_FRAMES = ['▁','▂','▃','▄','▅','▆','▇','█','▇','▆','▅','▄','▃','▂'] as const

function useAnimatedFrame(frames: readonly string[], intervalMs: number): string {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % frames.length), intervalMs)
    return () => clearInterval(id)
  }, [frames, intervalMs])
  return frames[index] ?? frames[0] ?? ''
}

interface ActivityIndicatorProps {
  detail: WorkspaceActivityDetail | undefined
  className?: string
}

export function ActivityIndicator({
  detail,
  className
}: ActivityIndicatorProps): React.JSX.Element | null {
  const braille = useAnimatedFrame(BRAILLE_FRAMES, 80)
  const tool = useAnimatedFrame(TOOL_FRAMES, 200)
  const compact = useAnimatedFrame(COMPACT_FRAMES, 100)

  if (!detail || detail === 'idle' || detail === 'archived') return null

  const base = 'inline-flex items-center justify-center flex-shrink-0 leading-none w-3'
  const cls = className ? `${base} ${className}` : base

  if (detail === 'thinking') {
    return <span className={`${cls} text-accent text-xs font-mono`}>{braille}</span>
  }
  if (detail === 'tool') {
    return <span className={`${cls} text-accent text-xs font-mono`}>{tool}</span>
  }
  if (detail === 'compacting') {
    return <span className={`${cls} text-accent text-xs font-mono`}>{compact}</span>
  }
  if (detail === 'ready') {
    return <span className={`${cls} text-emerald-400 text-xs font-mono`}>●</span>
  }
  if (detail === 'attention') {
    return <span className={`${cls} text-amber-400 text-xs font-mono animate-pulse`}>◆</span>
  }
  if (detail === 'asking') {
    return <span className={`${cls} text-amber-400 text-xs font-mono font-bold animate-pulse`}>?</span>
  }
  return null
}
