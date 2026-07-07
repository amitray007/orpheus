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
// `update(viewUpdate)` fires on EVERY CodeMirror ViewUpdate — scroll,
// geometry, focus, viewport recycling — not just doc/selection/query changes.
// Unconditionally notifying subscribers here means each subscriber's
// re-render (which re-walks the search cursor up to MATCH_COUNT_CAP matches)
// runs on every scroll tick too, even though the match count can't have
// changed. Gate notification to updates that can actually change what the
// panel renders: the document, the selection (the current-match index is
// derived from it), or the search query itself (case/regex/whole-word
// toggles, or the query text) — and skip pure viewport/scroll churn.
//
// Kept in its own module (not EditorSearchPanel.tsx) so the component file only
// exports components — satisfying react-refresh/only-export-components.
// ---------------------------------------------------------------------------

import { createRoot, type Root } from 'react-dom/client'
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view'
import { getSearchQuery } from '@codemirror/search'
import { EditorSearchPanel } from './EditorSearchPanel'

/** True when this update could change anything the search panel renders
 *  (match count, current-match index, or the query fields themselves). */
function isRelevantUpdate(update: ViewUpdate): boolean {
  if (update.docChanged || update.selectionSet) return true
  return !getSearchQuery(update.startState).eq(getSearchQuery(update.state))
}

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
    update(update: ViewUpdate) {
      if (!isRelevantUpdate(update)) return
      for (const cb of subscribers) cb()
    },
    destroy() {
      subscribers.clear()
      root?.unmount()
      root = null
    }
  }
}
