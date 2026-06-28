'use client'

import type React from 'react'

import { useDotMatrixPhases, usePrefersReducedMotion } from '@/components/ui/dotmatrix-hooks'
import { createPathWaveResolver } from '@/components/ui/dotmatrix-core-lib'
import type { DotMatrixCommonProps, NormFn } from '@/components/ui/dotmatrix-core-lib'
import { DotMatrixBase } from '@/components/ui/dotmatrix-core'

type PathWaveComponentProps = DotMatrixCommonProps

export function createPathWaveComponent(
  displayName: string,
  getPathNorm: NormFn
): React.ComponentType<PathWaveComponentProps> {
  const resolve = createPathWaveResolver(getPathNorm)

  function PathWaveComponent({
    pattern = 'full',
    animated = true,
    hoverAnimated = false,
    speed = 1,
    ...rest
  }: PathWaveComponentProps): React.JSX.Element {
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
        speed={speed}
        pattern={pattern}
        animated={animated}
        phase={matrixPhase}
        reducedMotion={reducedMotion}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        animationResolver={resolve}
      />
    )
  }

  PathWaveComponent.displayName = displayName
  return PathWaveComponent
}
