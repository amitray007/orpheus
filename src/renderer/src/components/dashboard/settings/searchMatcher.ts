import type { SettingsSearchEntry } from './searchIndex'

export interface SettingsSearchResult {
  entry: SettingsSearchEntry
  score: number
  matchedField: 'label' | 'description' | 'mapsTo' | 'keyword' | 'section'
  matchedText?: string
}

interface ScoreState {
  score: number
  matchedField: SettingsSearchResult['matchedField']
  matchedText: string | undefined
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^-+/, '')
    .replace(/[-_/.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function exactSubstring(target: string, query: string): boolean {
  return target.includes(query)
}

function tokenPrefixMatch(target: string, query: string): boolean {
  const queryTokens = query.split(' ').filter(Boolean)
  const targetWords = target.split(' ').filter(Boolean)
  return queryTokens.every((qt) => targetWords.some((tw) => tw.startsWith(qt)))
}

function subsequenceScore(target: string, query: string): number {
  if (query.length === 0) return 0
  let qi = 0
  let gaps = 0
  let lastMatchIdx = -1
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (lastMatchIdx !== -1) gaps += ti - lastMatchIdx - 1
      lastMatchIdx = ti
      qi++
    }
  }
  if (qi < query.length) return 0
  const coverage = query.length / target.length
  const gapPenalty = gaps / (query.length + 1)
  return coverage - gapPenalty * 0.3
}

// ---------------------------------------------------------------------------
// Per-strategy scoring helpers — each mirrors one numbered step from the
// original searchSettings loop EXACTLY (same thresholds, same score-wins
// comparisons, same matchedText source). Extracted purely to bring
// searchSettings' cognitive complexity under the lint cap; behavior/ranking
// is unchanged.
// ---------------------------------------------------------------------------

// 1. Exact substring on label
function scoreExactLabel(normLabel: string, q: string, entry: SettingsSearchEntry): ScoreState {
  const score = exactSubstring(normLabel, q) ? 100 : 0
  return { score, matchedField: 'label', matchedText: entry.label }
}

// 2. Token-prefix on label
function scoreTokenPrefixLabel(
  normLabel: string,
  q: string,
  entry: SettingsSearchEntry
): ScoreState {
  const score = tokenPrefixMatch(normLabel, q) ? 80 : 0
  return { score, matchedField: 'label', matchedText: entry.label }
}

// 3. Substring / token-prefix on mapsTo
function scoreMapsTo(normMapsTo: string[], q: string, entry: SettingsSearchEntry): ScoreState {
  let score = 0
  let matchedText: string | undefined
  for (const mt of normMapsTo) {
    if (exactSubstring(mt, q)) {
      if (score < 75) {
        score = 75
        matchedText = entry.mapsTo[normMapsTo.indexOf(mt)]
      }
      break
    }
    if (tokenPrefixMatch(mt, q)) {
      if (score < 65) {
        score = 65
        matchedText = entry.mapsTo[normMapsTo.indexOf(mt)]
      }
    }
  }
  return { score, matchedField: 'mapsTo', matchedText }
}

// 4. Substring / token-prefix on keywords
function scoreKeywords(normKeywords: string[], q: string, entry: SettingsSearchEntry): ScoreState {
  let score = 0
  let matchedText: string | undefined
  for (const kw of normKeywords) {
    if (exactSubstring(kw, q)) {
      if (score < 70) {
        score = 70
        matchedText = entry.keywords[normKeywords.indexOf(kw)]
      }
      break
    }
    if (tokenPrefixMatch(kw, q)) {
      if (score < 60) {
        score = 60
        matchedText = entry.keywords[normKeywords.indexOf(kw)]
      }
    }
  }
  return { score, matchedField: 'keyword', matchedText }
}

// 5. Substring on description
function scoreDescription(normDesc: string, q: string): ScoreState {
  const score = normDesc && exactSubstring(normDesc, q) ? 50 : 0
  return { score, matchedField: 'description', matchedText: undefined }
}

// 6. Fuzzy subsequence on label
function scoreFuzzyLabel(normLabel: string, q: string, entry: SettingsSearchEntry): ScoreState {
  const subScore = subsequenceScore(normLabel, q)
  const score = subScore > 0.3 ? Math.floor(subScore * 40) : 0
  return { score, matchedField: 'label', matchedText: entry.label }
}

// 7. Section label match
function scoreSection(normSection: string, q: string, entry: SettingsSearchEntry): ScoreState {
  const score = exactSubstring(normSection, q) ? 20 : 0
  return { score, matchedField: 'section', matchedText: entry.sectionLabel }
}

/**
 * Score a single entry against the normalized query, applying each strategy
 * in the same order and with the same score-wins / early-exit semantics as
 * the original inline implementation.
 */
function scoreEntry(entry: SettingsSearchEntry, q: string): ScoreState {
  const normLabel = normalize(entry.label)
  const normDesc = entry.description ? normalize(entry.description) : ''
  const normSection = normalize(entry.sectionLabel)
  const normMapsTo = entry.mapsTo.map(normalize)
  const normKeywords = entry.keywords.map(normalize)

  let score = 0
  let matchedField: SettingsSearchResult['matchedField'] = 'label'
  let matchedText: string | undefined

  const exactLabel = scoreExactLabel(normLabel, q, entry)
  if (exactLabel.score > 0) {
    score = Math.max(score, exactLabel.score)
    matchedField = exactLabel.matchedField
    matchedText = exactLabel.matchedText
  }

  if (score < 80) {
    const prefixLabel = scoreTokenPrefixLabel(normLabel, q, entry)
    if (prefixLabel.score > 0) {
      score = Math.max(score, prefixLabel.score)
      matchedField = prefixLabel.matchedField
      matchedText = prefixLabel.matchedText
    }
  }

  const mapsTo = scoreMapsTo(normMapsTo, q, entry)
  if (mapsTo.score > 0 && mapsTo.score > score) {
    score = mapsTo.score
    matchedField = mapsTo.matchedField
    matchedText = mapsTo.matchedText
  }

  const keywords = scoreKeywords(normKeywords, q, entry)
  if (keywords.score > 0 && keywords.score > score) {
    score = keywords.score
    matchedField = keywords.matchedField
    matchedText = keywords.matchedText
  }

  if (score < 50) {
    const desc = scoreDescription(normDesc, q)
    if (desc.score > 0) {
      score = desc.score
      matchedField = desc.matchedField
      matchedText = desc.matchedText
    }
  }

  if (score === 0) {
    const fuzzy = scoreFuzzyLabel(normLabel, q, entry)
    if (fuzzy.score > 0) {
      score = fuzzy.score
      matchedField = fuzzy.matchedField
      matchedText = fuzzy.matchedText
    }
  }

  if (score === 0) {
    const section = scoreSection(normSection, q, entry)
    if (section.score > 0) {
      score = section.score
      matchedField = section.matchedField
      matchedText = section.matchedText
    }
  }

  return { score, matchedField, matchedText }
}

export function searchSettings(
  query: string,
  index: SettingsSearchEntry[]
): SettingsSearchResult[] {
  const q = normalize(query)
  if (!q) return []

  const scored: SettingsSearchResult[] = []
  const seen = new Map<string, number>()

  for (const entry of index) {
    const { score, matchedField, matchedText } = scoreEntry(entry, q)
    if (score === 0) continue

    const key = `${entry.sectionId}:${entry.settingId}`
    const existing = seen.get(key)
    if (existing !== undefined && existing >= score) continue
    seen.set(key, score)

    scored.push({ entry, score, matchedField, matchedText })
  }

  scored.sort((a, b) => b.score - a.score)

  const deduped: SettingsSearchResult[] = []
  const dedupSeen = new Set<string>()
  for (const r of scored) {
    const key = `${r.entry.sectionId}:${r.entry.settingId}`
    if (dedupSeen.has(key)) continue
    dedupSeen.add(key)
    deduped.push(r)
    if (deduped.length >= 30) break
  }

  return deduped
}
