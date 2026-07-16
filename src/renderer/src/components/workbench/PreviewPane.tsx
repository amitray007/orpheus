// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/PreviewPane.tsx
//
// Files-tab Preview mode: renders markdown/HTML file contents as sanitized
// HTML, for the third `FilesViewMode` segment (Viewer | Editor | Preview).
// Renderer-only — no IPC, no backend. Reuses the file `contents` the Files
// tab already fetched via `files:readFile` (ContentPane); this component
// never re-reads the file itself.
//
// The md/html -> sanitized-HTML pipeline (and the MANDATORY DOMPurify.sanitize
// call — see its header comment) lives in ./previewRender.ts, split out so
// this file stays component-only (react-refresh/only-export-components).
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import type React from 'react'
import { PIERRE_VIEWER_BG } from './editor/chromeTheme'
import { renderToSafeHtml } from './previewRender'
import './preview-pane.css'

interface PreviewPaneProps {
  /** Raw file contents already fetched by ContentPane's readFile effect — this
   *  component never fetches on its own. */
  contents: string
  /** The selected file's repo-relative path — used only to pick the md-vs-html
   *  render branch (extension check), never re-read from disk. */
  path: string
}

/** Read-only rendered preview for markdown/HTML files. Switching out of
 *  Preview loses nothing (there's no buffer here to lose) — it's a pure
 *  function of the last-fetched `contents`, so unsaved Editor-mode edits are
 *  NOT reflected until saved (documented at the FilesTab call site). */
export function PreviewPane({ contents, path }: PreviewPaneProps): React.JSX.Element {
  const clean = useMemo(() => renderToSafeHtml(contents, path), [contents, path])
  return (
    <div
      className="flex-1 min-h-0 overflow-auto files-preview-prose"
      style={{ backgroundColor: PIERRE_VIEWER_BG }}
    >
      <div className="files-preview-prose__inner" dangerouslySetInnerHTML={{ __html: clean }} />
    </div>
  )
}
