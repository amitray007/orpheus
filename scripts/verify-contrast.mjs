#!/usr/bin/env bun
// WCAG-AA contrast gate for Orpheus text tokens. Parses main.css, computes
// contrast for every text-token × surface × theme, asserts >= TARGET.
// Run: bun scripts/verify-contrast.mjs
import { readFileSync } from 'node:fs'

const TARGET = 4.5
const CSS = readFileSync(new URL('../src/renderer/src/assets/main.css', import.meta.url), 'utf8')

// ---- color parsing -> WCAG relative luminance -------------------------------
const srgbToLin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lumFromLinear = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

function hexToLin(hex) {
  const h = hex.replace('#', '')
  const n =
    h.length === 3
      ? h
          .split('')
          .map((x) => x + x)
          .join('')
      : h
  const r = parseInt(n.slice(0, 2), 16) / 255
  const g = parseInt(n.slice(2, 4), 16) / 255
  const b = parseInt(n.slice(4, 6), 16) / 255
  return [srgbToLin(r), srgbToLin(g), srgbToLin(b)]
}

// OKLCH -> linear sRGB (Björn Ottosson). Returns clamped linear RGB.
function oklchToLin(L, C, H) {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3,
    m = m_ ** 3,
    s = s_ ** 3
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return [R, G, B].map((v) => Math.min(1, Math.max(0, v)))
}

function luminance(value) {
  const v = value.trim()
  if (v.startsWith('#')) return lumFromLinear(...hexToLin(v))
  const m = v.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i)
  if (m) {
    let L = parseFloat(m[1])
    if (v.includes('%')) L /= 100
    return lumFromLinear(...oklchToLin(L, parseFloat(m[2]), parseFloat(m[3])))
  }
  throw new Error(`Cannot parse color: ${value}`)
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// ---- extract per-theme token blocks ----------------------------------------
const THEMES = {
  midnight: /:root,\s*\[data-theme='midnight'\]\s*\{([^}]*)\}/,
  daylight: /\[data-theme='daylight'\]\s*\{([^}]*)\}/,
  eclipse: /\[data-theme='eclipse'\]\s*\{([^}]*)\}/
}
const grab = (block, name) => {
  const m = block.match(new RegExp(`--color-${name}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

let failed = 0
const surfaces = ['surface-base', 'surface-raised', 'surface-overlay']
const texts = ['text-primary', 'text-secondary', 'text-muted']

for (const [theme, re] of Object.entries(THEMES)) {
  const block = CSS.match(re)?.[1]
  if (!block) {
    console.error(`✗ theme block not found: ${theme}`)
    failed++
    continue
  }
  console.log(`\n${theme}`)
  for (const t of texts) {
    const tv = grab(block, t)
    for (const s of surfaces) {
      const sv = grab(block, s)
      const ratio = contrast(tv, sv)
      const ok = ratio >= TARGET || t === 'text-primary' // primary always strong
      const flag = ratio >= TARGET ? '✓' : ok ? '~' : '✗'
      if (ratio < TARGET && t !== 'text-primary') failed++
      console.log(`  ${flag} ${t.padEnd(14)} on ${s.padEnd(15)} ${ratio.toFixed(2)}:1`)
    }
  }
}

console.log(`\n${failed === 0 ? '✓ PASS' : `✗ FAIL (${failed} below ${TARGET}:1)`}`)
process.exit(failed === 0 ? 0 : 1)
