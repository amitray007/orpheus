// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/editor/searchPanel.tsx
//
// The CM `Panel` factory for the custom find/replace UI. Passed to
// `search({ createPanel })` in CodeEditor.tsx. It mounts a React root into the
// panel's dom rendering <EditorSearchPanel>, and cleanly unmounts it on the
// Panel's `destroy` (fired when the panel closes or the editor tears down) — so
// there is no leak and no double-mount (each open makes a fresh Panel + root).
//
// A tiny subscriber set bridges CM's `update(viewUpdate)` into the React tree
// so the match count / inputs track the live doc + selection.
//
// Kept in its own module (not EditorSearchPanel.tsx) so the component file only
// exports components — satisfying react-refresh/only-export-components.
// ---------------------------------------------------------------------------

import { createRoot, type Root } from 'react-dom/client'
import type { EditorView, Panel } from '@codemirror/view'
import { EditorSearchPanel } from './EditorSearchPanel'

/** Pass to `search({ createPanel })`. Returns a top-pinned Panel hosting a
 *  React root. */
export function makeSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'cm-orpheus-search'

  const subscribers = new Set<() => void>()
  const subscribe = (cb: () => void): (() => void) => {
    subscribers.add(cb)
    return () => {
      subscribers.delete(cb)
    }
  }

  let root: Root | null = null

  return {
    dom,
    top: true,
    mount() {
      root = createRoot(dom)
      root.render(<EditorSearchPanel view={view} subscribe={subscribe} />)
    },
    update() {
      for (const cb of subscribers) cb()
    },
    destroy() {
      subscribers.clear()
      root?.unmount()
      root = null
    }
  }
}
