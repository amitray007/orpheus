// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/previewRender.ts
//
// Pure helpers for the Files-tab Preview mode: which files are renderable,
// and the md/html -> sanitized-HTML pipeline. Split out of PreviewPane.tsx
// (which stays component-only) so react-refresh/only-export-components
// doesn't flag a non-component export sharing a file with a component.
//
// SECURITY (read before touching): `markdown-it` is configured with
// `html: true` (raw HTML passthrough inside markdown — needed so common
// README patterns like `<details>`/`<img align>` render), and `.html`/`.htm`
// files are rendered AS-IS. Both paths are therefore untrusted-HTML paths.
// `DOMPurify.sanitize(...)` is MANDATORY on both — it strips `<script>`,
// `on*` handler attributes, and `javascript:` URLs before the string ever
// reaches `dangerouslySetInnerHTML`. The renderer CSP (`script-src 'self'`)
// is a backstop, not a substitute: sanitize is the actual control here,
// because the user explicitly opted into rendering file-authored HTML (the
// higher-risk path a plain syntax-highlighted viewer never takes).
// ---------------------------------------------------------------------------

import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

// Extensions the Preview mode can render. Kept as its own set (not reusing
// IMAGE_EXTENSIONS from FilesTab.tsx) since this is a disjoint concept: images
// route to <img>, never through markdown-it/DOMPurify.
const RENDERABLE_EXTENSIONS = new Set(['md', 'markdown', 'html', 'htm'])

function extensionOf(path: string): string | null {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return null
  return path.slice(dot + 1).toLowerCase()
}

/** Whether `path`'s extension is one Preview mode knows how to render
 *  (markdown or HTML). Mirrors `isImagePath`'s shape in FilesTab.tsx. Exported
 *  so FilesTab.tsx can gate the ModeToggle's Preview segment and the
 *  mode-falls-back-to-viewer effect without duplicating the extension set. */
export function isRenderablePath(path: string): boolean {
  const ext = extensionOf(path)
  return ext !== null && RENDERABLE_EXTENSIONS.has(ext)
}

function isMarkdownPath(path: string): boolean {
  const ext = extensionOf(path)
  return ext === 'md' || ext === 'markdown'
}

// Module-singleton markdown-it instance — safe to share across renders/files
// since it's a pure `render(src) => string` transform with no per-call mutable
// state. `html: true` lets raw HTML embedded in markdown (e.g. `<details>`,
// `<img align="right">`) pass through to be rendered — this is exactly why
// DOMPurify.sanitize below is mandatory, not optional. `linkify: true` turns
// bare URLs in the source into clickable links.
const markdownRenderer = new MarkdownIt({ html: true, linkify: true })

/** md → HTML (markdown-it) or passthrough (.html/.htm) → DOMPurify.sanitize.
 *  MANDATORY sanitize call on both branches — see the file-header SECURITY
 *  note. The single call site here makes the "sanitize always runs" invariant
 *  easy to audit. */
export function renderToSafeHtml(contents: string, path: string): string {
  const raw = isMarkdownPath(path) ? markdownRenderer.render(contents) : contents
  return DOMPurify.sanitize(raw)
}
