// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/editor/codemirror-shiki.ts
//
// A CodeMirror 6 <-> Shiki syntax-highlighting bridge, VENDORED (not an npm
// dependency) per docs/learnings/pierre-libraries.md §9's recommendation: the
// look is too central to Orpheus to hang off a single-maintainer package, and
// the whole bridge is ~250 lines of well-understood glue.
//
// Attribution / license
// ---------------------
// The viewport-driven "tokenize the visible lines with Shiki, emit CodeMirror
// Mark decorations coloured from the token styles" technique this file
// implements is the same one used by the community `codemirror-shiki`
// project and antfu's Shiki<->editor bridges, all MIT-licensed. This is an
// independent, from-scratch typed reimplementation of that public technique.
//
// MIT License
// Copyright (c) 2024 the codemirror-shiki authors; (c) 2026 Orpheus.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the standard MIT conditions (full text:
// https://opensource.org/license/mit).
//
// How it works
// ------------
// Shiki is a whole-document, grammar-based highlighter — it has no incremental
// tokenizer. Running it over an entire large file on every keystroke would be
// far too slow. Instead we tokenize only the lines CodeMirror is actually
// showing (`view.visibleRanges`), which keeps highlight cost bounded by the
// viewport, not the file. A `ViewPlugin` recomputes decorations whenever the
// doc changes, the viewport moves, or the highlighter finishes loading. Each
// Shiki token becomes a `Decoration.mark` carrying an inline colour (+ bold/
// italic/underline) sourced from the same `pierre-dark` theme Pierre's <File>
// renders with, so editor tokens match the viewer exactly.
// ---------------------------------------------------------------------------

import type { Extension } from '@codemirror/state'
import { RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'
import type { ThemedToken } from 'shiki/core'

// Shiki's FontStyle is a bitmask (from vscode-textmate): Italic=1, Bold=2,
// Underline=4, Strikethrough=8. Declared locally to avoid importing the enum
// from a deep textmate path.
const FONT_ITALIC = 1
const FONT_BOLD = 2
const FONT_UNDERLINE = 4
const FONT_STRIKETHROUGH = 8

/** Minimal structural view of a loaded Shiki highlighter — only the calls this
 *  bridge makes. Any Shiki `Highlighter`/`HighlighterCore` satisfies it (their
 *  `codeToTokensBase` accepts the bundled-key OR string forms). Typed with
 *  plain `string` lang/theme here since the bridge passes runtime strings. */
export interface ShikiTokenizer {
  codeToTokensBase: (
    code: string,
    options: { lang?: string; theme?: string; includeExplanation?: boolean }
  ) => ThemedToken[][]
  getLoadedLanguages: () => string[]
  getLoadedThemes: () => string[]
}

export interface ShikiHighlightConfig {
  /** The loaded highlighter (already carrying the theme + languages). */
  highlighter: ShikiTokenizer
  /** The Shiki theme name to colour tokens with (e.g. `'pierre-dark'`). */
  theme: string
  /** The Shiki language id for this document (e.g. `'typescript'`). `'text'`
   *  skips tokenization entirely (plain, uncoloured). */
  lang: string
}

/** Build the inline CSS declaration for one token's style, or null when the
 *  token carries no colour/emphasis (so we can skip emitting a decoration). */
function tokenStyle(token: ThemedToken): string | null {
  const parts: string[] = []
  if (token.color) parts.push(`color:${token.color}`)
  const fs = token.fontStyle ?? 0
  if (fs & FONT_ITALIC) parts.push('font-style:italic')
  if (fs & FONT_BOLD) parts.push('font-weight:bold')
  const decorations: string[] = []
  if (fs & FONT_UNDERLINE) decorations.push('underline')
  if (fs & FONT_STRIKETHROUGH) decorations.push('line-through')
  if (decorations.length > 0) parts.push(`text-decoration:${decorations.join(' ')}`)
  return parts.length > 0 ? parts.join(';') : null
}

// Cache Mark decorations by style string — the same colour recurs on nearly
// every token, so this collapses thousands of identical `Decoration.mark`
// allocations per repaint down to a handful.
const markCache = new Map<string, Decoration>()
function markFor(style: string): Decoration {
  let mark = markCache.get(style)
  if (!mark) {
    mark = Decoration.mark({ attributes: { style } })
    markCache.set(style, mark)
  }
  return mark
}

/**
 * Tokenize a single visible line via Shiki and append its token decorations to
 * `builder`, offset to the line's absolute document position `lineStart`.
 * Ranges must be added to a `RangeSetBuilder` in ascending order, and Shiki
 * returns tokens left-to-right, so per-line appends stay ordered.
 */
function highlightLine(
  builder: RangeSetBuilder<Decoration>,
  highlighter: ShikiTokenizer,
  text: string,
  lineStart: number,
  theme: string,
  lang: string
): void {
  if (text.length === 0) return
  let lines: ThemedToken[][]
  try {
    lines = highlighter.codeToTokensBase(text, { lang, theme, includeExplanation: false })
  } catch {
    return // grammar hiccup on a partial line — leave it uncoloured, never throw.
  }
  const tokens = lines[0]
  if (!tokens) return
  for (const token of tokens) {
    const from = lineStart + token.offset
    const to = from + token.content.length
    if (to <= from) continue
    const style = tokenStyle(token)
    if (style) builder.add(from, to, markFor(style))
  }
}

/**
 * Compute the decoration set for the editor's current viewport. Only lines that
 * intersect `view.visibleRanges` are tokenized, so highlight cost tracks the
 * viewport, not the document size.
 */
function buildDecorations(view: EditorView, config: ShikiHighlightConfig): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { highlighter, theme, lang } = config
  if (lang === 'text' || lang === 'plaintext') return builder.finish()
  // Guard: if the requested lang/theme isn't actually loaded, tokenizing would
  // throw per-line; bail to plain text instead.
  if (!highlighter.getLoadedThemes().includes(theme)) return builder.finish()
  const langLoaded = lang === 'ansi' || highlighter.getLoadedLanguages().includes(lang)
  if (!langLoaded) return builder.finish()

  const doc = view.state.doc
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = doc.lineAt(pos)
      highlightLine(builder, highlighter, line.text, line.from, theme, lang)
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * A CodeMirror extension that syntax-highlights the visible viewport using the
 * supplied Shiki highlighter + theme + language. Recomputes on doc change and
 * on viewport change. Returns a `ViewPlugin` extension ready to drop into an
 * `EditorView`'s `extensions`.
 */
export function shikiHighlighting(config: ShikiHighlightConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, config)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, config)
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations
    }
  )
}
