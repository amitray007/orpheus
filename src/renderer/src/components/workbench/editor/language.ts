// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/editor/language.ts
//
// Maps a file's extension to BOTH:
//   - a CodeMirror 6 language `Extension` (for bracket matching, indentation,
//     folding — the editing smarts), and
//   - a Shiki language id (for the pierre-dark token colouring via the vendored
//     bridge in ./codemirror-shiki.ts).
//
// The two are separate concerns: CM's `@codemirror/lang-*` packs drive editor
// behaviour; Shiki drives the visual token colours. We keep them in one table
// so a single extension lookup yields both. Unknown extensions get no CM lang
// extension and Shiki lang `'text'` (plain, uncoloured, still editable).
// ---------------------------------------------------------------------------

import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'

export interface ResolvedLanguage {
  /** The CodeMirror language extension, or null for plain text. */
  cm: Extension | null
  /** The Shiki language id for token colouring (`'text'` = uncoloured). */
  shiki: string
}

// CodeMirror lang factories are memoized so repeated lookups (e.g. re-opening
// the same file type) don't reconstruct the LanguageSupport each time.
const jsTs = (): Extension => javascript({ typescript: true })
const jsxTsx = (): Extension => javascript({ typescript: true, jsx: true })

interface LangEntry {
  cm: () => Extension | null
  shiki: string
}

const NULL_CM = (): Extension | null => null

// Extension (lowercase, no dot) → { CM factory, Shiki id }.
const BY_EXTENSION: Record<string, LangEntry> = {
  // JS / TS family — one CM pack (lang-javascript) covers all four via options.
  js: { cm: jsTs, shiki: 'javascript' },
  mjs: { cm: jsTs, shiki: 'javascript' },
  cjs: { cm: jsTs, shiki: 'javascript' },
  jsx: { cm: jsxTsx, shiki: 'jsx' },
  ts: { cm: jsTs, shiki: 'typescript' },
  mts: { cm: jsTs, shiki: 'typescript' },
  cts: { cm: jsTs, shiki: 'typescript' },
  tsx: { cm: jsxTsx, shiki: 'tsx' },
  // JSON
  json: { cm: json, shiki: 'json' },
  jsonc: { cm: json, shiki: 'jsonc' },
  // Markup / styles
  html: { cm: html, shiki: 'html' },
  htm: { cm: html, shiki: 'html' },
  xml: { cm: html, shiki: 'xml' },
  svg: { cm: html, shiki: 'xml' },
  css: { cm: css, shiki: 'css' },
  scss: { cm: css, shiki: 'scss' },
  less: { cm: css, shiki: 'less' },
  // Markdown
  md: { cm: markdown, shiki: 'markdown' },
  mdx: { cm: markdown, shiki: 'markdown' },
  markdown: { cm: markdown, shiki: 'markdown' },
  // Python
  py: { cm: python, shiki: 'python' },
  pyi: { cm: python, shiki: 'python' },
  // Languages with a Shiki grammar but no installed CM pack — still colour via
  // Shiki, edit as plain text (bracket matching etc. degrade gracefully).
  yml: { cm: NULL_CM, shiki: 'yaml' },
  yaml: { cm: NULL_CM, shiki: 'yaml' },
  toml: { cm: NULL_CM, shiki: 'toml' },
  sh: { cm: NULL_CM, shiki: 'shellscript' },
  bash: { cm: NULL_CM, shiki: 'shellscript' },
  zsh: { cm: NULL_CM, shiki: 'shellscript' },
  sql: { cm: NULL_CM, shiki: 'sql' },
  rs: { cm: NULL_CM, shiki: 'rust' },
  go: { cm: NULL_CM, shiki: 'go' },
  swift: { cm: NULL_CM, shiki: 'swift' },
  c: { cm: NULL_CM, shiki: 'c' },
  h: { cm: NULL_CM, shiki: 'c' },
  cpp: { cm: NULL_CM, shiki: 'cpp' },
  cc: { cm: NULL_CM, shiki: 'cpp' },
  hpp: { cm: NULL_CM, shiki: 'cpp' },
  java: { cm: NULL_CM, shiki: 'java' }
}

const PLAIN: ResolvedLanguage = { cm: null, shiki: 'text' }

/** Resolve a file's language from its name/path. Case-insensitive on the
 *  extension; unknown extensions → plain text. */
export function languageFor(fileName: string): ResolvedLanguage {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return PLAIN
  const ext = fileName.slice(dot + 1).toLowerCase()
  const entry = BY_EXTENSION[ext]
  if (!entry) return PLAIN
  return { cm: entry.cm(), shiki: entry.shiki }
}
