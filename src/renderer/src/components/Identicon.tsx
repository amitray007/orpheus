import type React from 'react'
import { useState } from 'react'
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
