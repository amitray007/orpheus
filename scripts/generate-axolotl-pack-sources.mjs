#!/usr/bin/env node
// One-off generator for the axolotl icon pack's *source* files
// (resources/icon-sets/axolotl/<variant>/app/app.svg + menubar SVGs).
//
// The axolotl pack's app art is approved production raster artwork (not a
// hand-drawn vector master like wisp/dreamer/legacy), so app.svg is a thin
// 1024x1024 SVG wrapper embedding that PNG as a base64 data URI, clipped to
// the same rx=238 rounded-rect macOS icon shape every other pack's app.svg
// draws directly (see e.g. resources/icon-sets/wisp/production/app/app.svg's
// `<rect rx="238">`). This keeps build-icon-pack.mjs's existing sourceSvg
// contract (it rasterizes any 1024x1024 SVG canvas) without introducing a
// second source-asset format, and without rounding corners on the original
// PNG artwork itself — the clip lives in the wrapper only.
//
// The menu-bar glyphs use a deterministic vector axolotl silhouette (head
// outline + two frilled gills + two eyes + smile), since a 32-64px menu-bar/
// template rendering needs to read as a simple mark, not a downscaled
// photo-real raster.
//
// Source PNGs live at resources/icon-sets/axolotl/sources/<variant>.png —
// byte-identical copies of the approved generated artwork, committed to the
// repo so this script (and build-icon-pack.mjs) work from a fresh checkout
// with no private machine paths.
//
// Usage: node scripts/generate-axolotl-pack-sources.mjs
// Then:  node scripts/build-icon-pack.mjs axolotl

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
const PACK_ROOT = path.join(REPOSITORY_ROOT, 'resources', 'icon-sets', 'axolotl')
const SOURCES_ROOT = path.join(PACK_ROOT, 'sources')

// Same rounded-rect corner radius every other pack's app.svg draws on its
// 1024x1024 canvas (see e.g. wisp/production/app/app.svg's `<rect rx="238">`).
const APP_ICON_CORNER_RADIUS = 238

const VARIANTS = {
  production: {
    sourcePng: path.join(SOURCES_ROOT, 'production.png'),
    label: 'Production',
    description: 'A smiling pink axolotl mascot on a dark charcoal field with a plum tint.',
    bodyColor: '#f4a191',
    gillColor: '#8f1d3f',
    cheekColor: '#f4877a'
  },
  development: {
    sourcePng: path.join(SOURCES_ROOT, 'development.png'),
    label: 'Development',
    description: 'A smiling pink axolotl mascot on a muted sage field.',
    bodyColor: '#f4a191',
    gillColor: '#8f1d3f',
    cheekColor: '#f4877a'
  },
  nightly: {
    sourcePng: path.join(SOURCES_ROOT, 'nightly.png'),
    label: 'Nightly',
    description: 'A smiling pink axolotl mascot on a midnight indigo field.',
    bodyColor: '#f4a191',
    gillColor: '#8f1d3f',
    cheekColor: '#f4877a'
  }
}

// Deterministic simplified axolotl mark shared by every variant's menu-bar
// glyphs — a rounded head, two three-lobed gill frills, two eyes, one smile.
// Coordinates chosen to sit inside a 64x64 canvas with margin for the frills.
const HEAD_PATH =
  'M20 46C13 40 12 30 18 23C24 16 34 14 42 19C50 24 53 34 48 42C44 49 36 52 28 50C25 49 22 48 20 46Z'
const GILL_LEFT_PATH =
  'M18 23C12 20 6 21 3 26C7 25 10 27 11 31C7 31 4 34 4 38C8 36 11 37 13 40C16 33 17 28 18 23Z'
const GILL_RIGHT_PATH =
  'M42 19C46 13 52 11 58 14C54 15 52 19 53 23C57 22 61 24 62 28C58 28 56 31 56 35C50 30 45 25 42 19Z'
const EYE_LEFT = { cx: 25, cy: 32, rx: 2.6, ry: 3.4 }
const EYE_RIGHT = { cx: 37, cy: 30, rx: 3.4, ry: 4.4 }
const SMILE_PATH = 'M28 40C30 42 33 42 35 40'
const CHEEK = { cx: 22, cy: 39, r: 3.2 }

function menuBarIconSvg(idPrefix, label, { bodyColor, gillColor, cheekColor }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="64"
  height="64"
  viewBox="0 0 64 64"
  role="img"
  aria-labelledby="${idPrefix}-title ${idPrefix}-description"
>
  <title id="${idPrefix}-title">${label} Axolotl menu-bar icon</title>
  <desc id="${idPrefix}-description">A compact axolotl glyph with frilled gills.</desc>
  <path d="${GILL_LEFT_PATH}" fill="${gillColor}"/>
  <path d="${GILL_RIGHT_PATH}" fill="${gillColor}"/>
  <path d="${HEAD_PATH}" fill="${bodyColor}"/>
  <circle cx="${CHEEK.cx}" cy="${CHEEK.cy}" r="${CHEEK.r}" fill="${cheekColor}" opacity=".55"/>
  <ellipse cx="${EYE_LEFT.cx}" cy="${EYE_LEFT.cy}" rx="${EYE_LEFT.rx}" ry="${EYE_LEFT.ry}" fill="#2a0f14"/>
  <ellipse cx="${EYE_RIGHT.cx}" cy="${EYE_RIGHT.cy}" rx="${EYE_RIGHT.rx}" ry="${EYE_RIGHT.ry}" fill="#2a0f14"/>
  <circle cx="${EYE_LEFT.cx - 0.8}" cy="${EYE_LEFT.cy - 1.2}" r="0.7" fill="#fff8f4"/>
  <circle cx="${EYE_RIGHT.cx - 1}" cy="${EYE_RIGHT.cy - 1.6}" r="0.9" fill="#fff8f4"/>
  <path d="${SMILE_PATH}" fill="none" stroke="#5c1220" stroke-width="1.6" stroke-linecap="round"/>
</svg>
`
}

function menuBarTemplateSvg(idPrefix, label) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="64"
  height="64"
  viewBox="0 0 64 64"
  role="img"
  aria-labelledby="${idPrefix}-title ${idPrefix}-description"
>
  <title id="${idPrefix}-title">${label} Axolotl macOS template icon</title>
  <desc id="${idPrefix}-description">A monochrome axolotl silhouette with eye and smile cutouts.</desc>
  <defs>
    <mask id="${idPrefix}-cutouts" x="0" y="0" width="64" height="64" maskUnits="userSpaceOnUse">
      <rect width="64" height="64" fill="#fff"/>
      <ellipse cx="${EYE_LEFT.cx}" cy="${EYE_LEFT.cy}" rx="${EYE_LEFT.rx - 0.5}" ry="${EYE_LEFT.ry - 0.5}" fill="#000"/>
      <ellipse cx="${EYE_RIGHT.cx}" cy="${EYE_RIGHT.cy}" rx="${EYE_RIGHT.rx - 0.6}" ry="${EYE_RIGHT.ry - 0.6}" fill="#000"/>
      <path d="${SMILE_PATH}" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round"/>
    </mask>
  </defs>
  <path d="${GILL_LEFT_PATH}" fill="#000" mask="url(#${idPrefix}-cutouts)"/>
  <path d="${GILL_RIGHT_PATH}" fill="#000" mask="url(#${idPrefix}-cutouts)"/>
  <path d="${HEAD_PATH}" fill="#000" mask="url(#${idPrefix}-cutouts)"/>
</svg>
`
}

async function appSourceSvg(idPrefix, label, description, pngPath) {
  const buffer = await readFile(pngPath)
  const dataUri = `data:image/png;base64,${buffer.toString('base64')}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  width="1024"
  height="1024"
  viewBox="0 0 1024 1024"
  role="img"
  aria-labelledby="${idPrefix}-title ${idPrefix}-description"
>
  <title id="${idPrefix}-title">${label} Axolotl app icon</title>
  <desc id="${idPrefix}-description">${description}</desc>
  <defs>
    <clipPath id="${idPrefix}-clip">
      <rect width="1024" height="1024" rx="${APP_ICON_CORNER_RADIUS}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#${idPrefix}-clip)">
    <image
      x="0"
      y="0"
      width="1024"
      height="1024"
      preserveAspectRatio="xMidYMid slice"
      xlink:href="${dataUri}"
    />
  </g>
</svg>
`
}

async function main() {
  for (const [variantName, config] of Object.entries(VARIANTS)) {
    const variantRoot = path.join(PACK_ROOT, variantName)
    const idPrefix = `axolotl-${variantName}`

    const appSvg = await appSourceSvg(
      `${idPrefix}-app`,
      config.label,
      config.description,
      config.sourcePng
    )
    await writeFile(path.join(variantRoot, 'app', 'app.svg'), appSvg, 'utf8')

    const menuSvg = menuBarIconSvg(`${idPrefix}-menubar`, config.label, config)
    await writeFile(path.join(variantRoot, 'menubar', 'icon.svg'), menuSvg, 'utf8')

    const templateSvg = menuBarTemplateSvg(`${idPrefix}-template`, config.label)
    await writeFile(path.join(variantRoot, 'menubar', 'iconTemplate.svg'), templateSvg, 'utf8')

    console.log(`wrote sources for axolotl/${variantName}`)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
