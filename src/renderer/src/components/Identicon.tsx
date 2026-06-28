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
  //
  // Keep minidenticon's native viewBox (`-1.5 -1.5 8 8`) so the pattern renders
  // at its intrinsic size/padding — just give the <svg> explicit square pixel
  // dimensions and preserveAspectRatio so it can never be distorted by its
  // container. The box wraps the icon at its own size; we do NOT stretch the
  // artwork to fill a larger box.
  const svg = useMemo(() => {
    const raw = minidenticon(seed, 75, 55)
    return raw.replace(
      '<svg ',
      `<svg width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet" `
    )
  }, [seed, size])

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="inline-block rounded overflow-hidden flex-shrink-0 object-cover"
        style={{ width: size, height: size, minWidth: size, minHeight: size }}
      />
    )
  }

  // inline-flex shrink-wraps the SVG: the box adapts to the icon's size, not the
  // other way around.
  return (
    <span
      dangerouslySetInnerHTML={{ __html: svg }}
      className="inline-flex flex-shrink-0 rounded overflow-hidden [&>svg]:block"
    />
  )
}
