// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/diffHighlighterPreload.ts
//
// Pierre-adoption Batch 1a, quick-win #4 (scratchpad/pierre-roadmap.json,
// "Pre-warm the shared Shiki highlighter") — warms @pierre/diffs' shared
// Shiki highlighter singleton with the pierre-dark/pierre-light themes plus a
// pragmatic common-language set ONCE per app lifetime, so the FIRST <PatchDiff>
// mount (Git tab, any file) doesn't pay Shiki's cold create-highlighter +
// grammar-resolve cost synchronously on that first paint. Without this, the
// first diff ever opened in a session visibly stalls for the highlighter to
// spin up; every diff after that is instant because @pierre/diffs caches the
// highlighter as a module-level singleton (see
// node_modules/@pierre/diffs/dist/highlighter/shared_highlighter.d.ts).
//
// Engine: intentionally does NOT pass `preferredHighlighter` — @pierre/diffs'
// own `getSharedHighlighter`/`preloadHighlighter` default to `'shiki-js'`
// (confirmed in dist/highlighter/*.js during U1, see
// docs/learnings/pierre-libraries.md §9's finding), i.e. Shiki's pure-JS
// regex engine (`createJavaScriptRegexEngine()`), NOT the Oniguruma/WASM
// engine — the renderer's CSP has no `wasm-unsafe-eval`, so WASM would
// reject. This mirrors editor/highlighter.ts's own explicit engine choice
// for the Files-tab CodeMirror bridge; omitting the option here reaches the
// same engine via @pierre/diffs' default rather than needing to specify it
// again, since `preloadHighlighter` has no engine-selection knob beyond
// `preferredHighlighter`.
//
// Guarded so repeated calls (e.g. GitTab remounting on a tab switch, or a
// FilesTab <File>/<PatchDiff> mounting first) are no-ops after the first —
// `preloadHighlighter` itself is idempotent (shared_highlighter.ts's
// `highlighter ??= ...` singleton), but this module-level flag additionally
// avoids issuing a redundant call (and its microtask overhead) on every
// GitTab mount.
// ---------------------------------------------------------------------------

import { preloadHighlighter } from '@pierre/diffs'

// Common langs across both this repo's own stack (TS/TSX/JS/Swift/ObjC/C++)
// and the arbitrary user projects Orpheus opens — mirrors the pragmatic set
// editor/highlighter.ts already warms for the Files-tab editor, so the two
// highlighter singletons (editor's own + @pierre/diffs' shared one) end up
// resolving the same grammars rather than each cold-resolving independently
// the first time a given language is actually opened.
const DIFF_PRELOAD_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'python',
  'shellscript',
  'markdown',
  'yaml',
  'swift',
  'c',
  'cpp',
  'objective-c'
] as const

let preloadStarted = false

/**
 * Kick off warming @pierre/diffs' shared highlighter. Safe to call from
 * multiple mount points — only the first call actually issues the
 * `preloadHighlighter` request; later calls are no-ops. Fire-and-forget by
 * design (the caller renders <PatchDiff> regardless of whether this has
 * settled — Pierre lazily resolves on demand either way; this just gets a
 * head start before the user actually opens a diff).
 */
export function preloadDiffHighlighter(): void {
  if (preloadStarted) return
  preloadStarted = true
  preloadHighlighter({
    themes: ['pierre-dark', 'pierre-light'],
    langs: [...DIFF_PRELOAD_LANGS]
  }).catch((err: unknown) => {
    // Non-fatal — a failed warm-up just means the first real diff falls back
    // to Pierre's own lazy on-demand resolve (the pre-existing behavior).
    // Reset the flag so a later mount can retry rather than being stuck
    // believing the warm-up already happened.
    preloadStarted = false
    console.warn('[GitTab] preloadDiffHighlighter failed (non-fatal):', err)
  })
}
