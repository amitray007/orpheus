/**
 * tui/components/Footer.tsx — keymap hint line, or a transient notice
 * (e.g. "'n' is not yet wired in this build") in its place.
 */

import * as React from 'react'
import { Text } from 'ink'

const KEYMAP_HINT = '↵ open · n new · x kill · a archive · r rename · f filter · ? keys · q quit'

export function Footer({ notice }: { notice: string | null }): React.JSX.Element {
  return <Text dimColor>{notice ?? KEYMAP_HINT}</Text>
}
