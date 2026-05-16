/**
 * DotmSquare11 — dot-matrix loading indicator.
 *
 * Placeholder implementation while @dotmatrix/dotm-square-11 from the shadcn
 * registry is unavailable (registry not reachable; no components.json in this
 * project). Visually equivalent: an 11×11 dot grid where dots animate in a
 * wave pattern using staggered Tailwind animation delays.
 *
 * Swap this file wholesale when the real shadcn component becomes available.
 */

import type React from 'react'

interface DotmSquare11Props {
  /** Dot diameter in pixels. Default 3. */
  dotSize?: number
  /** Gap between dots in pixels. Default 2. */
  gap?: number
  className?: string
}

const ROWS = 11
const COLS = 11

export function DotmSquare11({
  dotSize = 3,
  gap = 2,
  className
}: DotmSquare11Props): React.JSX.Element {
  const total = ROWS * COLS
  const dots = Array.from({ length: total }, (_, i) => i)

  return (
    <div
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${COLS}, ${dotSize}px)`,
        gap: `${gap}px`
      }}
    >
      {dots.map((i) => {
        const delay = ((i % COLS) + Math.floor(i / COLS)) * 40
        return (
          <div
            key={i}
            style={{
              width: dotSize,
              height: dotSize,
              borderRadius: '50%',
              background: 'currentColor',
              animation: `dotm-pulse 1.2s ease-in-out ${delay}ms infinite`
            }}
          />
        )
      })}
      <style>{`
        @keyframes dotm-pulse {
          0%, 100% { opacity: 0.15; }
          50%       { opacity: 0.7; }
        }
      `}</style>
    </div>
  )
}
