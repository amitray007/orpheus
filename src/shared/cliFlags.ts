// ---------------------------------------------------------------------------
// src/shared/cliFlags.ts
//
// Quote-aware argv lexer + scope merger for the "custom CLI flags" feature
// (see docs/superpowers/specs/2026-07-15-custom-cli-flags-design.md).
//
// Orpheus lets users type arbitrary `claude` CLI flags as free text (global +
// project scope). This module turns each free-text entry into argv tokens and
// merges the two scopes into one token list. It is deliberately dependency-
// free and imports nothing from `main/` or `renderer/` — both the renderer
// (live validation as the user types) and main (final composition in
// claudeSettings.ts) need byte-identical behavior, and `shared-not-to-*`
// dependency-cruiser rules forbid this file reaching into a process-specific
// layer anyway.
//
// LOAD-BEARING CONSTRAINT (do not relitigate — see the design doc's
// "transport problem" section): validation here is SYNTAX ONLY. This module
// must never reject a flag for being unknown to `claude --help` — hidden
// flags (e.g. --dangerously-load-development-channels) are accepted by
// claude's parser despite being undocumented, and reaching them is the whole
// point of the feature. The only errors are lexical: unbalanced quotes, an
// empty entry, or an entry that doesn't start with `-`.
// ---------------------------------------------------------------------------

/** One parsed flag entry, as typed by the user. */
export interface ParsedFlag {
  /** Exactly what the user typed, verbatim. */
  raw: string
  /** Canonical flag name, e.g. "--model". Empty string for bare operands
   *  (an entry with no leading `-` token — currently unreachable via
   *  parseFlagEntry since that shape is a syntax error, but kept on the type
   *  for forward compatibility / callers that construct ParsedFlag directly). */
  name: string
  /** The argv tokens this entry contributes, in order. */
  tokens: string[]
}

/** A human-readable, UI-displayable syntax error. Never an "unknown flag"
 *  error — see the module-level note above. */
export type FlagParseError = { error: string }

/** Unit Separator (0x1F) — the wire-format delimiter for argv tokens passed
 *  through the ORPHEUS_CLAUDE_FLAGS env var. Chosen over NUL (env vars are
 *  NUL-terminated C strings and cannot embed one) and over whitespace (cannot
 *  survive a round trip through shell word-splitting once a value itself
 *  contains whitespace). See the design doc's "Choosing a delimiter" section
 *  for the empirical verification. */
export const FLAG_DELIMITER = '\x1f'

const ERR_UNBALANCED_QUOTE: FlagParseError = { error: 'Unbalanced quote' }
const ERR_EMPTY_FLAG: FlagParseError = { error: 'Empty flag' }
const ERR_MUST_START_WITH_DASH: FlagParseError = { error: 'Flags must start with - or --' }

function isFlagParseError(v: ParsedFlag | FlagParseError): v is FlagParseError {
  return 'error' in v
}

/**
 * Quote-aware whitespace tokenizer. Splits `raw` into words the way a shell
 * would for the purposes of this feature: whitespace separates tokens except
 * inside a matching pair of single or double quotes, and quote characters
 * are stripped from the resulting word (not left in like `${(z)VAR}` would).
 * Unlike a real shell, this never evaluates `$(...)`, backticks, globs, or
 * escape sequences — values are literal text, by design (see the doc's
 * non-goals).
 *
 * Returns null on an unbalanced quote.
 */
function tokenizeWords(raw: string): string[] | null {
  const words: string[] = []
  let current = ''
  let hasCurrent = false
  let quote: '"' | "'" | null = null
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]

    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      hasCurrent = true
      i++
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasCurrent) {
        words.push(current)
        current = ''
        hasCurrent = false
      }
      i++
      continue
    }

    current += ch
    hasCurrent = true
    i++
  }

  if (quote) return null
  if (hasCurrent) words.push(current)
  return words
}

/**
 * Splits a single word on the first top-level `=` (i.e. one that is not
 * inside quotes), stripping quotes from the value side only. Used for the
 * `--flag=value` and `--flag="value with spaces"` forms, where the `=` and
 * everything after it must survive as ONE token (`--flag=value`), unlike the
 * `--flag value` form which contributes two tokens.
 *
 * Returns null if there is no top-level `=` (the word isn't `=`-joined).
 */
function splitEqualsJoined(word: string): { name: string; value: string } | null {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '=') {
      const name = word.slice(0, i)
      const rawValue = word.slice(i + 1)
      const value = stripSurroundingQuotes(rawValue)
      return { name, value }
    }
  }
  return null
}

/** Strips a single pair of surrounding matching quotes, if present. Used for
 *  the value side of an `=`-joined flag, which tokenizeWords doesn't see as
 *  its own word (the whole `--flag="a b"` is one whitespace-delimited word). */
function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * Parses one free-text flag entry (as typed into the CLI-flags editor UI)
 * into argv tokens. See the module-level doc comment: validation is syntax
 * only, never "is this a real flag".
 */
export function parseFlagEntry(raw: string): ParsedFlag | FlagParseError {
  if (raw.trim() === '') return ERR_EMPTY_FLAG

  const words = tokenizeWords(raw)
  if (words === null) return ERR_UNBALANCED_QUOTE
  if (words.length === 0) return ERR_EMPTY_FLAG

  const first = words[0]
  const eqSplit = splitEqualsJoined(first)
  const firstFlagPart = eqSplit ? eqSplit.name : first
  if (!firstFlagPart.startsWith('-')) return ERR_MUST_START_WITH_DASH

  const tokens: string[] = []
  if (eqSplit) {
    tokens.push(`${eqSplit.name}=${eqSplit.value}`)
  } else {
    tokens.push(first)
  }
  for (let i = 1; i < words.length; i++) {
    tokens.push(words[i])
  }

  return { raw, name: flagName(raw), tokens }
}

/**
 * Extracts the canonical flag name from a raw entry, e.g. both
 * "--model opus" and "--model=opus" normalize to "--model" so the two forms
 * are recognized as the same flag for conflict detection. Returns '' if the
 * entry has no leading `-` token (including empty/unparseable entries).
 */
export function flagName(raw: string): string {
  const words = tokenizeWords(raw)
  if (!words || words.length === 0) return ''
  const first = words[0]
  const eqSplit = splitEqualsJoined(first)
  const name = eqSplit ? eqSplit.name : first
  return name.startsWith('-') ? name : ''
}

/** Flag names whose CLI surface is variadic/repeatable (accepts the flag
 *  multiple times to accumulate a list), derived from `claude --help`'s
 *  variadic markers (`<directories...>`, `<tools...>`, …) — see the design
 *  doc's merge section. For these, both scopes' entries survive the merge;
 *  for everything else, project overrides global on a name collision. */
const REPEATABLE = new Set([
  '--add-dir',
  '--allowed-tools',
  '--allowedTools',
  '--disallowed-tools',
  '--betas',
  '--mcp-config',
  '--tools',
  '--file'
])

/**
 * Merges global-scope and project-scope flag argv token lists into one argv
 * token list, per the design doc's rule: append, but project wins on
 * same-name conflict — except for REPEATABLE flags, which accumulate from
 * both scopes instead of the later one replacing the earlier one.
 *
 * Inputs are argv TOKEN arrays already produced by parseFlagEntry (i.e. one
 * flag entry may already be flattened into multiple tokens); this function
 * re-groups them by entry using the same tokenizer logic is NOT needed here
 * — grouping happens by re-parsing the *entries*, not the token stream, so
 * callers must pass one joined string per entry through parseFlagEntry
 * upstream and hand this function the resulting raw entry strings. To keep
 * the public surface small and match the spec's signature exactly, this
 * function accepts token arrays directly and groups them by re-splitting on
 * flag boundaries (a token starting with `-` begins a new entry's name; any
 * immediately following non-dash-prefixed tokens are that flag's values).
 *
 * Order: surviving global tokens first, then project tokens. Unknown flags
 * default to override (the safer, common-case behavior).
 */
export function mergeFlagScopes(globalFlags: string[], projectFlags: string[]): string[] {
  const globalEntries = groupTokensByFlag(globalFlags)
  const projectEntries = groupTokensByFlag(projectFlags)
  const projectNames = new Set(projectEntries.map((e) => e.name))

  const survivingGlobal = globalEntries.filter(
    (e) => REPEATABLE.has(e.name) || !projectNames.has(e.name)
  )

  return [...survivingGlobal, ...projectEntries].flatMap((e) => e.tokens)
}

interface FlagTokenGroup {
  name: string
  tokens: string[]
}

/**
 * Groups a flat argv token array back into per-flag entries: a token
 * starting with `-` opens a new entry (its canonical name derived the same
 * way flagName() would from an `=`-joined token); subsequent tokens that
 * don't start with `-` are values belonging to that entry. A leading run of
 * value-shaped tokens with no preceding flag (malformed input) is dropped —
 * mergeFlagScopes only ever receives well-formed output from parseFlagEntry,
 * so this is a defensive fallback, not a real code path.
 */
function groupTokensByFlag(tokens: string[]): FlagTokenGroup[] {
  const groups: FlagTokenGroup[] = []
  for (const token of tokens) {
    if (token.startsWith('-')) {
      const eqIdx = token.indexOf('=')
      const name = eqIdx === -1 ? token : token.slice(0, eqIdx)
      groups.push({ name, tokens: [token] })
    } else if (groups.length > 0) {
      groups[groups.length - 1].tokens.push(token)
    }
    // else: dropped — value with no preceding flag, not producible by
    // parseFlagEntry (which always rejects an entry not starting with '-').
  }
  return groups
}

// Re-exported for callers that want to distinguish a parse failure without a
// duplicated type guard.
export { isFlagParseError }
