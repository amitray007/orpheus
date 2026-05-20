'use client'

import type React from 'react'
import type { CSSProperties } from 'react'

import { DotMatrixBase } from '@/components/ui/dotmatrix-core'
import { useDotMatrixPhases, usePrefersReducedMotion } from '@/components/ui/dotmatrix-hooks'
import type { DotAnimationResolver, DotMatrixCommonProps } from '@/components/ui/dotmatrix-core'

// Footer-specific loader: cross pattern, grad-neon color, size 10 dots.
// Uses a rotating fade sweep distinct from the ripple-echo used in dotm-square-11.
const animationResolver: DotAnimationResolver = ({ isActive, row, col, reducedMotion, phase }) => {
  if (!isActive) {
    return { className: 'dmx-inactive' }
  }

  // Sweep along the cross arms with a diagonal path norm
  const pathNorm = (row + col) / 8
  const style = { '--dmx-path': pathNorm } as CSSProperties

  if (reducedMotion || phase === 'idle') {
    return { style: { ...style, opacity: 0.15 + pathNorm * 0.7 } }
  }

  return { className: 'dmx-path', style }
}

export type DotmFooterLoaderProps = DotMatrixCommonProps

export function DotmFooterLoader({
  speed = 1.6,
  pattern = 'cross',
  animated = true,
  hoverAnimated = false,
  colorPreset = 'grad-neon',
  ...rest
}: DotmFooterLoaderProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const {
    phase: matrixPhase,
    onMouseEnter,
    onMouseLeave
  } = useDotMatrixPhases({
    animated: Boolean(animated && !reducedMotion),
    hoverAnimated: Boolean(hoverAnimated && !reducedMotion),
    speed
  })

  return (
    <DotMatrixBase
      {...rest}
      size={rest.size ?? 16}
      dotSize={rest.dotSize ?? 2}
      speed={speed}
      pattern={pattern}
      colorPreset={colorPreset}
      animated={animated}
      phase={matrixPhase}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      reducedMotion={reducedMotion}
      animationResolver={animationResolver}
    />
  )
}
