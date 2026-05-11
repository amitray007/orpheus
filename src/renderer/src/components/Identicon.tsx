import type React from 'react'
import { minidenticon } from 'minidenticons'

interface IdenticonProps {
  seed: string
  size?: number
}

/**
 * Deterministic SVG identicon seeded by project path.
 * Saturation=75, lightness=55 gives vibrant but readable colors on dark bg.
 *
 * TODO(future): try GH org avatar via git config remote.origin.url +
 * https://github.com/<org>.png; fall back to minidenticon on failure.
 */
export function Identicon({ seed, size = 20 }: IdenticonProps): React.JSX.Element {
  const svg = minidenticon(seed, 75, 55)
  return (
    <span
      style={{ width: size, height: size, minWidth: size }}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
      className="inline-block rounded overflow-hidden flex-shrink-0"
    />
  )
}
