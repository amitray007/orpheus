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
const surfaces = ['surface-base']
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
    if (!tv) {
      console.error(`  ✗ missing token: ${t} in ${theme}`)
      failed++
      continue
    }
    for (const s of surfaces) {
      const sv = grab(block, s)
      if (!sv) {
        console.error(`  ✗ missing token: ${s} in ${theme}`)
        failed++
        continue
      }
      const ratio = contrast(tv, sv)
      const flag = ratio >= TARGET ? '✓' : '✗'
      if (ratio < TARGET) failed++
      console.log(`  ${flag} ${t.padEnd(14)} on ${s.padEnd(15)} ${ratio.toFixed(2)}:1`)
    }
  }
}

// ---- accent-aware chrome: text must clear AA on the *tinted* raised/overlay ---
// color-mix(in oklch, accent P%, base): interpolate in OKLab (≈ oklch for these
// small P, no hue-arc edge cases) and convert the result to WCAG luminance.
function toOklab(value) {
  const v = value.trim()
  if (v.startsWith('oklch')) {
    const m = v.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i)
    let L = parseFloat(m[1])
    if (v.includes('%')) L /= 100
    const C = parseFloat(m[2])
    const H = (parseFloat(m[3]) * Math.PI) / 180
    return { L, a: C * Math.cos(H), b: C * Math.sin(H) }
  }
  const [r, g, b] = hexToLin(v) // linear sRGB
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}
function oklabToLum({ L, a, b }) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3,
    m = m_ ** 3,
    s = s_ ** 3
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  const cl = (x) => Math.min(1, Math.max(0, x))
  return lumFromLinear(cl(R), cl(G), cl(B))
}
function mixLum(baseVal, accentVal, t) {
  const A = toOklab(baseVal),
    B = toOklab(accentVal)
  return oklabToLum({
    L: A.L + (B.L - A.L) * t,
    a: A.a + (B.a - A.a) * t,
    b: A.b + (B.b - A.b) * t
  })
}
const ratioL = (l1, l2) => {
  const [hi, lo] = [l1, l2].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const ACCENTS = {}
for (const m of CSS.matchAll(/\[data-accent='([a-z]+)'\]\s*\{[^}]*?--color-accent:\s*([^;]+);/g)) {
  ACCENTS[m[1]] = m[2].trim()
}
console.log('\naccent-tinted chrome (raised 4% / overlay 3%)')
for (const [theme, re] of Object.entries(THEMES)) {
  const block = CSS.match(re)?.[1]
  if (!block) continue
  const accents = { default: grab(block, 'accent'), ...ACCENTS }
  const mixes = [
    ['raised', grab(block, 'surface-raised-base'), 0.04],
    ['overlay', grab(block, 'surface-overlay-base'), 0.03]
  ].filter(([sname, sbase]) => {
    if (!sbase) {
      console.error(`  ✗ missing token: surface-${sname}-base in ${theme}`)
      failed++
      return false
    }
    return true
  })
  for (const t of texts) {
    const tl = luminance(grab(block, t))
    for (const [an, av] of Object.entries(accents)) {
      for (const [sname, sbase, pct] of mixes) {
        const r = ratioL(tl, mixLum(sbase, av, pct))
        if (r < TARGET) {
          failed++
          console.log(`  ✗ ${theme}/${an}: ${t} on ${sname} ${r.toFixed(2)}:1`)
        }
      }
    }
  }
}

console.log(`\n${failed === 0 ? '✓ PASS' : `✗ FAIL (${failed} below ${TARGET}:1)`}`)
process.exit(failed === 0 ? 0 : 1)
