import type React from 'react'

/**
 * Transparent overlay strip that makes the top of the window draggable.
 * 36px matches the macOS traffic-light row height.
 *
 * Any interactive element layered inside this strip must carry
 * style={{ WebkitAppRegion: 'no-drag' }} (or equivalent CSS) so clicks
 * are not swallowed by the drag handler.
 */
export function TitleBarDragRegion(): React.JSX.Element {
  return <div className="titlebar-drag-region fixed top-0 left-0 h-9 w-full" />
}
