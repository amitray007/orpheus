// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/previewRender.ts
//
// Pure helpers for the Files-tab Preview mode: which files are renderable,
// and the md/html/svg -> sanitized-HTML pipeline. Split out of PreviewPane.tsx
// (which stays component-only) so react-refresh/only-export-components
// doesn't flag a non-component export sharing a file with a component.
//
// SECURITY (read before touching): `markdown-it` is configured with
// `html: true` (raw HTML passthrough inside markdown — needed so common
// README patterns like `<details>`/`<img align>` render), and `.html`/`.htm`/
// `.svg` files are rendered AS-IS (passthrough). All three paths are
// therefore untrusted-HTML (or untrusted-SVG, which can carry the same
// `<script>`/event-handler payloads) paths. `DOMPurify.sanitize(...)` is
// MANDATORY on all of them — it strips `<script>`, `on*` handler attributes,
// and `javascript:` URLs before the string ever reaches
// `dangerouslySetInnerHTML`. DOMPurify's default config already sanitizes SVG
// safely while preserving the vector markup (`<svg>`, `<circle>`, `<path>`,
// etc. survive; `<script>`/`onload`/... do not) — no special SVG profile
// needed. The renderer CSP (`script-src 'self'`) is a backstop, not a
// substitute: sanitize is the actual control here, because the user
// explicitly opted into rendering file-authored markup (the higher-risk path
// a plain syntax-highlighted viewer never takes).
// ---------------------------------------------------------------------------

import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

// Extensions the Preview mode can render. Kept as its own set (not reusing
// IMAGE_EXTENSIONS from FilesTab.tsx) since this is a disjoint concept:
// raster images (png/jpg/gif/webp/avif) route to <img> in FilesTab's
// ImageBody, never through markdown-it/DOMPurify. SVG is text/XML source —
// it's deliberately NOT in FilesTab's IMAGE_EXTENSIONS — and renders here via
// the same passthrough+sanitize path as HTML (see isHtmlLikePath below).
const RENDERABLE_EXTENSIONS = new Set(['md', 'markdown', 'html', 'htm', 'svg'])

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

/** md → HTML (markdown-it) or passthrough (.html/.htm/.svg) → DOMPurify.sanitize.
 *  MANDATORY sanitize call on every branch — see the file-header SECURITY
 *  note. The single call site here makes the "sanitize always runs" invariant
 *  easy to audit. SVG takes the SAME passthrough branch as HTML (raw contents
 *  straight into DOMPurify) — it is not markdown, so `isMarkdownPath` already
 *  routes it there without any extra branching. */
export function renderToSafeHtml(contents: string, path: string): string {
  const raw = isMarkdownPath(path) ? markdownRenderer.render(contents) : contents
  return DOMPurify.sanitize(raw)
}
