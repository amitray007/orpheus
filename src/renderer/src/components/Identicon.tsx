import type React from 'react'
import { useMemo, useState } from 'react'
import { minidenticon } from 'minidenticons'

interface IdenticonProps {
  seed: string
  size?: number
  avatarUrl?: string | null
}

/**
 * Deterministic SVG identicon seeded by project path.
 * Saturation=75, lightness=55 gives vibrant but readable colors on dark bg.
 *
 * When avatarUrl is provided (GitHub CDN URL), renders the avatar image instead.
 * Falls back to the minidenticon if the image fails to load.
 */
export function Identicon({ seed, size = 20, avatarUrl }: IdenticonProps): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  // Hoisted above the early return so hook order stays stable across renders.
  const svg = useMemo(() => minidenticon(seed, 75, 55), [seed])

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="inline-block rounded overflow-hidden flex-shrink-0 object-cover"
        style={{ width: size, height: size, minWidth: size }}
      />
    )
  }

  return (
    <span
      style={{ width: size, height: size, minWidth: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
      className="inline-block rounded overflow-hidden flex-shrink-0"
    />
  )
}
