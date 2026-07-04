// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/editor/highlighter.ts
//
// A lazily-created, module-singleton Shiki highlighter for the Files-tab
// EDITOR, loaded with Pierre's exact `pierre-dark` theme so editor tokens match
// the read-only <File> viewer pixel-for-pixel (both are Shiki + pierre-dark).
//
// Shiki (and all its bundled themes/languages) is already pulled in by
// `@pierre/diffs`, so this adds no new runtime weight — it just spins up a
// second highlighter instance configured with the languages the editor
// supports and the same `pierre-dark` theme object Pierre ships
// (`@pierre/theme/pierre-dark`). The default JS regex engine is used (no WASM),
// matching the viewer (docs/learnings/pierre-libraries.md §9).
// ---------------------------------------------------------------------------

import { createHighlighter, type ThemeRegistrationAny } from 'shiki'
import pierreDark from '@pierre/theme/pierre-dark'
import type { ShikiTokenizer } from './codemirror-shiki'

// The Shiki theme NAME the editor colours with. `pierreDark.name` is
// `'pierre-dark'`; naming it explicitly keeps the bridge config readable.
export const EDITOR_THEME_NAME = 'pierre-dark'

// The languages the editor loads up front. A pragmatic common set mirroring the
// CodeMirror language packs installed; anything outside this list falls back to
// plain `'text'` (still editable, just uncoloured). Kept in sync with
// languageFor() in ./language.ts.
const EDITOR_LANGS = [
  'javascript',
  'jsx',
  'typescript',
  'tsx',
  'json',
  'jsonc',
  'html',
  'xml',
  'css',
  'scss',
  'less',
  'markdown',
  'python',
  'shellscript',
  'yaml',
  'toml',
  'sql',
  'rust',
  'go',
  'swift',
  'c',
  'cpp',
  'java'
] as const

let highlighterPromise: Promise<ShikiTokenizer> | null = null

/**
 * Get (creating on first call) the shared editor highlighter. The instance is a
 * module singleton — every CodeEditor shares it, so the theme + grammars are
 * loaded exactly once for the whole app. Safe to call repeatedly; concurrent
 * callers await the same in-flight promise. Returned as the narrow
 * `ShikiTokenizer` shape the bridge needs (the full `Highlighter` has stricter
 * bundled-key generics that would reject the runtime string langs we pass).
 */
export function getEditorHighlighter(): Promise<ShikiTokenizer> {
  if (!highlighterPromise) {
    const created = createHighlighter({
      // pierre-dark is a frozen VS Code / TextMate theme object; Shiki accepts a
      // theme object directly and normalizes it (adds `settings`/`fg`/`bg`). Its
      // declared `PierreTheme` type is a structural subset of ThemeRegistration,
      // so cast at this one boundary.
      themes: [pierreDark as unknown as ThemeRegistrationAny],
      langs: [...EDITOR_LANGS]
    })
      // The full Highlighter carries stricter bundled-key generics on
      // codeToTokensBase than the runtime-string ShikiTokenizer shape the bridge
      // uses; the runtime behaviour is identical, so narrow it here.
      .then((h): ShikiTokenizer => h as unknown as ShikiTokenizer)
      .catch((err: unknown) => {
        // Reset so a later mount can retry rather than being stuck on a rejected
        // promise forever.
        highlighterPromise = null
        throw err instanceof Error ? err : new Error(String(err))
      })
    highlighterPromise = created
  }
  return highlighterPromise
}
