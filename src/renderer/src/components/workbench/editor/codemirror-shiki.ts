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
// far too slow. Instead we tokenize only what CodeMirror is actually showing
// (`view.visibleRanges`), which keeps highlight cost bounded by the viewport,
// not the file. Each visible range is tokenized as ONE joined block (not
// line-by-line) so Shiki's grammar state carries correctly across lines
// within that range — block comments, template literals, and JSX/HTML spans
// stay coloured consistently instead of resetting every line (see
// `highlightBlock`). A `ViewPlugin` recomputes decorations whenever the doc
// changes, the viewport moves, or the highlighter finishes loading. Each
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
 * Tokenize one visible BLOCK (the joined text of a contiguous run of visible
 * lines) via a single Shiki call and append its token decorations to
 * `builder`, mapped back to absolute document positions via `blockStart`.
 *
 * TextMate/Shiki grammars are STATEFUL across lines — block comments,
 * template literals, JSX/HTML spans, and triple-quoted strings all depend on
 * which construct is open when a line starts. Tokenizing each visible line in
 * isolation (one `codeToTokensBase` call per line) restarts the grammar from
 * its root state on every line, so any of those multi-line constructs get
 * mis-coloured from line 2 onward. Calling `codeToTokensBase` ONCE on the
 * whole joined block preserves that cross-line state for everything the
 * block covers, at the cost of remaining imperfect for constructs that started
 * ABOVE the visible viewport (acceptable — full-document tokenization would
 * defeat the point of viewport-scoped highlighting).
 *
 * `codeToTokensBase` returns one token array per input line, but critically
 * each token's `offset` is relative to the WHOLE input string passed in (i.e.
 * block-relative), not reset per line — so tokens from every line of the
 * block can be mapped with the same `blockStart + token.offset` formula.
 * Ranges must be added to a `RangeSetBuilder` in ascending order; Shiki
 * returns lines top-to-bottom and tokens left-to-right within a line, so
 * flattening in order preserves that.
 */
function highlightBlock(
  builder: RangeSetBuilder<Decoration>,
  highlighter: ShikiTokenizer,
  block: string,
  blockStart: number,
  theme: string,
  lang: string
): void {
  if (block.length === 0) return
  let lines: ThemedToken[][]
  try {
    lines = highlighter.codeToTokensBase(block, { lang, theme, includeExplanation: false })
  } catch {
    return // grammar hiccup on the block — leave it uncoloured, never throw.
  }
  for (const lineTokens of lines) {
    for (const token of lineTokens) {
      const from = blockStart + token.offset
      const to = from + token.content.length
      if (to <= from) continue
      const style = tokenStyle(token)
      if (style) builder.add(from, to, markFor(style))
    }
  }
}

/**
 * Compute the decoration set for the editor's current viewport. Each entry in
 * `view.visibleRanges` is tokenized as ONE joined block (not per line), so
 * Shiki's grammar state carries across the lines within that visible range —
 * see `highlightBlock`. Highlight cost still tracks the viewport, not the
 * document size: one `codeToTokensBase` call per visible range instead of one
 * per visible line.
 */
function buildDecorations(view: EditorView, config: ShikiHighlightConfig): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { highlighter, theme, lang } = config
  if (lang === 'text' || lang === 'plaintext') return builder.finish()
  // Guard: if the requested lang/theme isn't actually loaded, tokenizing would
  // throw; bail to plain text instead.
  if (!highlighter.getLoadedThemes().includes(theme)) return builder.finish()
  const langLoaded = lang === 'ansi' || highlighter.getLoadedLanguages().includes(lang)
  if (!langLoaded) return builder.finish()

  const doc = view.state.doc
  for (const { from, to } of view.visibleRanges) {
    // Extend to full line boundaries so the joined block contains whole lines
    // (matching how `codeToTokensBase` splits its input on `\n`), then join
    // with `doc.sliceString` so `blockStart` (the first line's `.from`) plus
    // Shiki's block-relative `token.offset` lands on the right document pos.
    const startLine = doc.lineAt(from)
    const endLine = doc.lineAt(to)
    const block = doc.sliceString(startLine.from, endLine.to)
    highlightBlock(builder, highlighter, block, startLine.from, theme, lang)
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
