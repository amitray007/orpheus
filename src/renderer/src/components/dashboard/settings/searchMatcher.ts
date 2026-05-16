import type { SettingsSearchEntry } from './searchIndex'

export interface SettingsSearchResult {
  entry: SettingsSearchEntry
  score: number
  matchedField: 'label' | 'description' | 'mapsTo' | 'keyword' | 'section'
  matchedText?: string
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

export function searchSettings(
  query: string,
  index: SettingsSearchEntry[]
): SettingsSearchResult[] {
  const q = normalize(query)
  if (!q) return []

  const scored: SettingsSearchResult[] = []
  const seen = new Map<string, number>()

  for (const entry of index) {
    const normLabel = normalize(entry.label)
    const normDesc = entry.description ? normalize(entry.description) : ''
    const normSection = normalize(entry.sectionLabel)
    const normMapsTo = entry.mapsTo.map(normalize)
    const normKeywords = entry.keywords.map(normalize)

    let score = 0
    let matchedField: SettingsSearchResult['matchedField'] = 'label'
    let matchedText: string | undefined

    // 1. Exact substring on label
    if (exactSubstring(normLabel, q)) {
      score = Math.max(score, 100)
      matchedField = 'label'
      matchedText = entry.label
    }

    // 2. Token-prefix on label
    if (score < 80 && tokenPrefixMatch(normLabel, q)) {
      score = Math.max(score, 80)
      matchedField = 'label'
      matchedText = entry.label
    }

    // 3. Substring on mapsTo
    for (const mt of normMapsTo) {
      if (exactSubstring(mt, q)) {
        if (score < 75) {
          score = 75
          matchedField = 'mapsTo'
          matchedText = entry.mapsTo[normMapsTo.indexOf(mt)]
        }
        break
      }
      if (tokenPrefixMatch(mt, q)) {
        if (score < 65) {
          score = 65
          matchedField = 'mapsTo'
          matchedText = entry.mapsTo[normMapsTo.indexOf(mt)]
        }
      }
    }

    // 4. Substring on keywords
    for (const kw of normKeywords) {
      if (exactSubstring(kw, q)) {
        if (score < 70) {
          score = 70
          matchedField = 'keyword'
          matchedText = entry.keywords[normKeywords.indexOf(kw)]
        }
        break
      }
      if (tokenPrefixMatch(kw, q)) {
        if (score < 60) {
          score = 60
          matchedField = 'keyword'
          matchedText = entry.keywords[normKeywords.indexOf(kw)]
        }
      }
    }

    // 5. Substring on description
    if (normDesc && exactSubstring(normDesc, q)) {
      if (score < 50) {
        score = 50
        matchedField = 'description'
        matchedText = undefined
      }
    }

    // 6. Fuzzy subsequence on label
    if (score === 0) {
      const subScore = subsequenceScore(normLabel, q)
      if (subScore > 0.3) {
        score = Math.floor(subScore * 40)
        matchedField = 'label'
        matchedText = entry.label
      }
    }

    // 7. Section label match
    if (score === 0 && exactSubstring(normSection, q)) {
      score = 20
      matchedField = 'section'
      matchedText = entry.sectionLabel
    }

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
