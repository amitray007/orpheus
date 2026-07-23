// ---------------------------------------------------------------------------
// src/main/models/sources/builtin.ts — the Claude model source
//
// Authoritative, OFFLINE, and FIRST in the registry's precedence order (see
// registry.ts). Every Claude model id/alias resolves fully from this file
// alone — no network, no models.dev. This is the hard guarantee that keeps
// Claude "structurally privileged": Claude must never degrade to unknown,
// and no other source is ever consulted for an id this source recognizes.
//
// Data here mirrors the values that used to live in src/main/pricing.ts's
// FALLBACK_PRICING (kept in sync manually — see that file's header comment
// for the cross-check policy). This is now the single place that data lives;
// pricing.ts's FALLBACK_PRICING is superseded by this source.
// ---------------------------------------------------------------------------

import type { ModelInfo, ModelSource, Pricing } from '../types'

type ClaudeModelDef = {
  id: string
  label: string
  pricing: Pricing
  context: number
}

// Explicit versioned ids — unambiguous pricing + context lookup. Family for
// all of these is 'opus' | 'sonnet' | 'haiku' | 'fable', derived from the id.
const CLAUDE_MODELS: ClaudeModelDef[] = [
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    context: 1_000_000
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    context: 1_000_000
  },
  {
    id: 'claude-opus-4-5',
    label: 'Opus 4.5',
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    context: 200_000
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    context: 1_000_000
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    context: 1_000_000
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    context: 200_000
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    context: 200_000
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    context: 1_000_000
  }
]

// Always-latest aliases — claude resolves the exact version at launch. Priced
// as a representative "latest" so cost accounting stays sane before the
// concrete version is known.
const CLAUDE_ALIASES: ClaudeModelDef[] = [
  {
    id: 'opus',
    label: 'Opus (latest)',
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    context: 1_000_000
  },
  {
    id: 'sonnet',
    label: 'Sonnet (latest)',
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    context: 1_000_000
  },
  {
    id: 'haiku',
    label: 'Haiku (latest)',
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    context: 200_000
  },
  {
    id: 'fable',
    label: 'Fable (latest)',
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    context: 1_000_000
  }
]

const ALL_CLAUDE_MODELS = [...CLAUDE_MODELS, ...CLAUDE_ALIASES]

// Exact-id lookup table, built once.
const BY_ID = new Map<string, ClaudeModelDef>(ALL_CLAUDE_MODELS.map((m) => [m.id, m]))

// Longest-first prefix list, for date-stamped variants like
// "claude-opus-4-7-20260416" (claude appends a release date to the id it
// actually runs). Aliases are deliberately excluded from prefix matching —
// "opus" is 4 chars and would prefix-match all sorts of unrelated ids.
const PREFIX_CANDIDATES = [...CLAUDE_MODELS].sort((a, b) => b.id.length - a.id.length)

function familyOf(id: string): string | null {
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('fable')) return 'fable'
  return null
}

function toModelInfo(requestedId: string, def: ClaudeModelDef): ModelInfo {
  return {
    id: requestedId,
    label: def.label,
    family: familyOf(def.id),
    isClaude: true,
    context: def.context,
    pricing: def.pricing,
    // No Claude model currently exposes visible/extended reasoning via this
    // registry's contract; flip per-model if that changes.
    supportsReasoning: false
  }
}

/**
 * Structural guard: is `id` a Claude model id/alias by OUR OWN definition
 * (exact match or date-stamped-suffix match against a known Claude id) —
 * never substring/family-name matching. This is what the rest of the app
 * (and the registry) should call instead of ad-hoc `.includes('claude')` or
 * `.includes('opus')` checks.
 */
export function isClaudeModelId(id: string): boolean {
  if (BY_ID.has(id)) return true
  return PREFIX_CANDIDATES.some((def) => id.startsWith(def.id))
}

function resolveClaudeModel(modelId: string): ModelInfo | null {
  const exact = BY_ID.get(modelId)
  if (exact) return toModelInfo(modelId, exact)

  // Date-stamped variant, e.g. "claude-opus-4-7-20260416" → "claude-opus-4-7".
  // Longest-prefix-wins so "claude-opus-4-7-x" doesn't fall back to a shorter
  // "claude-opus-4" entry if one ever existed.
  for (const def of PREFIX_CANDIDATES) {
    if (modelId.startsWith(def.id)) return toModelInfo(modelId, def)
  }

  return null
}

// Exactly "-" followed by an 8-digit YYYYMMDD date stamp, nothing more —
// the real shape Anthropic appends to an id (e.g. "-20251001"). Deliberately
// STRICTER than PREFIX_CANDIDATES' plain startsWith (used by
// isClaudeModelId/resolveClaudeModel above for resolving genuine Claude API
// response text, where a merely-prefixed garbage suffix never occurs in
// practice) — bareClaudeIdFor below feeds untrusted-shaped candidate pools
// (models.dev's catalog, local session data) where a bare startsWith WOULD
// wrongly match a third-party reseller's own SKU suffix, e.g.
// "claude-opus-4-7@default" or "claude-haiku-4-5-20251001-thinking" (both
// real models.dev entries from non-Anthropic provider buckets like
// google-vertex/nano-gpt) — see routingProxy/manager.ts's
// buildStampedVariantsByBareId and modelsDev.ts's listModelsDevCachedIds doc
// comments for the full incident writeup this guards against.
const DATE_STAMP_SUFFIX = /^-\d{8}$/

/**
 * Which known bare/versioned Claude id (a CLAUDE_MODELS entry, e.g.
 * "claude-haiku-4-5") owns `id` — either because `id` IS that bare id, or
 * because `id` is a CLEAN date-stamped variant of it (e.g.
 * "claude-haiku-4-5-20251001" — exactly the bare id plus "-" plus 8 digits,
 * nothing else trailing). Returns null for anything this source doesn't
 * recognize, including:
 *   - the "always-latest" aliases like "opus" (excluded from prefix matching
 *     entirely — see PREFIX_CANDIDATES' own comment — since they have no
 *     date-stamped form to begin with)
 *   - a merely-PREFIXED id that isn't a clean date stamp (e.g.
 *     "claude-opus-4-7-fast", "claude-haiku-4-5@20251001",
 *     "claude-haiku-4-5-20251001-thinking") — unlike isClaudeModelId/
 *     resolveClaudeModel above (which intentionally accept any prefix match
 *     for resolving genuine Claude API response text), this function is
 *     deliberately strict because its real callers feed it candidate pools
 *     that include OTHER VENDORS' OWN PRODUCT SKUs sharing a Claude-shaped
 *     prefix (see DATE_STAMP_SUFFIX's own comment) — a loose match here
 *     would alias a Claude name to the wrong upstream model's target by
 *     conflating "looks like it starts with a Claude id" with "IS a
 *     date-stamped Claude id Anthropic actually mints".
 *
 * This is the ONE place "does stamped id X belong to bare id Y" is decided —
 * reused by routingProxy/manager.ts's stamped-alias expansion (model-routing
 * unit 09-polish) so that expansion never re-derives its own notion of "is
 * this a Claude id" via string matching. Deliberately returns the bare
 * CLAUDE_MODELS id, never a CLAUDE_ALIASES entry, matching PREFIX_CANDIDATES'
 * own scope.
 */
export function bareClaudeIdFor(id: string): string | null {
  if (BY_ID.has(id) && CLAUDE_MODELS.some((m) => m.id === id)) return id
  for (const def of PREFIX_CANDIDATES) {
    if (id.startsWith(def.id) && DATE_STAMP_SUFFIX.test(id.slice(def.id.length))) {
      return def.id
    }
  }
  return null
}

/**
 * The builtin Claude source. Synchronous, offline, and — per registry.ts's
 * precedence order — always tried FIRST. Because resolution here is exact-id
 * or exact-id-prefix only (never substring/family-name matching against
 * arbitrary ids), a third-party id that merely CONTAINS "opus"/"sonnet"/
 * "haiku"/"fable" (e.g. a hypothetical "some-vendor-opus-clone") is correctly
 * left unresolved by this source and falls through to later sources — it can
 * never inherit Claude pricing.
 */
export const builtinClaudeSource: ModelSource = {
  name: 'builtin-claude',
  resolve: resolveClaudeModel
}
