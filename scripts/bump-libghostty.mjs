#!/usr/bin/env bun
// Bump the pinned GhosttyKit.xcframework in scripts/fetch-libghostty.sh.
//
// Lakr233/libghostty-spm publishes the xcframework asset on its `storage.*`
// releases (the bare version tags like `1.2.6` carry no assets), and rotates
// old `storage.*` tags out — so a hardcoded URL eventually 404s. This script
// resolves the newest `storage.*` release that carries GhosttyKit.xcframework.zip,
// downloads it, computes the SHA-256, and rewrites the three pin constants
// (GHOSTTYKIT_URL / GHOSTTYKIT_SHA256 / GHOSTTYKIT_LABEL).
//
// Usage:  bun run bump:libghostty
//   exit 0, file rewritten  → a newer release was pinned
//   exit 0, no change       → already on the newest release
//   exit 1                  → error (network / no release / parse)
//
// The pin model is intentionally preserved: fetch-libghostty.sh still verifies
// every download against the pinned SHA. This script only updates the pin; review
// the resulting diff (and build) before merging — the rolling lib's C API can drift.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = 'Lakr233/libghostty-spm'
const ASSET = 'GhosttyKit.xcframework.zip'
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fetch-libghostty.sh')

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const apiHeaders = {
  'User-Agent': 'orpheus-bump-libghostty',
  Accept: 'application/vnd.github+json',
  ...(token ? { Authorization: `Bearer ${token}` } : {})
}

async function api(path) {
  const res = await fetch(`https://api.github.com/${path}`, { headers: apiHeaders })
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}\n${await res.text()}`)
  return res.json()
}

console.log(`[bump-libghostty] resolving newest storage.* release for ${REPO}…`)
const releases = await api(`repos/${REPO}/releases?per_page=30`)
const storage = releases
  .filter((r) => /^storage\./.test(r.tag_name) && (r.assets ?? []).some((a) => a.name === ASSET))
  .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]
if (!storage) throw new Error(`no \`storage.*\` release carrying ${ASSET} was found in ${REPO}`)

const url = storage.assets.find((a) => a.name === ASSET).browser_download_url
const label = `${storage.tag_name} (Ghostty rolling)`

const current = readFileSync(SCRIPT, 'utf8')
const currentUrl = current.match(/GHOSTTYKIT_URL="([^"]+)"/)?.[1]
if (currentUrl === url) {
  console.log(`[bump-libghostty] already current at ${storage.tag_name} — no change`)
  process.exit(0)
}

console.log(`[bump-libghostty] newest is ${storage.tag_name}; downloading the asset to hash it…`)
const dl = await fetch(url, {
  headers: { 'User-Agent': apiHeaders['User-Agent'] },
  redirect: 'follow'
})
if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status} for ${url}`)
const bytes = Buffer.from(await dl.arrayBuffer())
const sha = createHash('sha256').update(bytes).digest('hex')
console.log(`[bump-libghostty]   sha256 = ${sha}  (${bytes.length} bytes)`)

const updated = current
  .replace(/GHOSTTYKIT_URL="[^"]*"/, `GHOSTTYKIT_URL="${url}"`)
  .replace(/GHOSTTYKIT_SHA256="[^"]*"/, `GHOSTTYKIT_SHA256="${sha}"`)
  .replace(/GHOSTTYKIT_LABEL="[^"]*"/, `GHOSTTYKIT_LABEL="${label}"`)

if (updated === current) {
  throw new Error('pin constants not found in fetch-libghostty.sh — did the format change?')
}

writeFileSync(SCRIPT, updated)
console.log(`[bump-libghostty] pinned ${storage.tag_name}`)
console.log(`  ${currentUrl ?? '(none)'}\n  → ${url}`)
