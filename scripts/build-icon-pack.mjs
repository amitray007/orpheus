#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
const CATALOG_ROOT = path.join(REPOSITORY_ROOT, 'resources', 'icon-sets')
const PACK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VARIANT_NAMES = ['production', 'development', 'nightly']
const ICONSET_FRAMES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

// macOS app icons conventionally occupy ~82.8% of their canvas with transparent
// margin around the artwork (measured against Claude.app / Brave Browser.app at
// 512x512: art 424x424, padding L44 R44 T49 B39 — top-heavy by design). Our SVG
// masters draw full-bleed, so the inset is applied here at raster time instead of
// by editing the artwork. Expressed as ratios so every ICONSET_FRAMES size gets
// proportionally correct padding.
const APP_ICON_INSET_RATIO = {
  artwork: 848 / 1024,
  left: 88 / 1024,
  top: 98 / 1024,
  right: 88 / 1024,
  bottom: 78 / 1024
}

function fail(message) {
  throw new Error(message)
}

function assertPackId(value) {
  if (!PACK_ID_PATTERN.test(value)) {
    fail(`Invalid pack ID "${value}". Expected lowercase letters, numbers, and hyphens.`)
  }
}

function assertInside(root, candidate, label) {
  const relativePath = path.relative(root, candidate)
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    fail(`${label} must resolve below ${root}`)
  }
}

function resolveAsset(packRoot, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    fail(`${label} must be a non-empty relative path`)
  }
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) {
    fail(`${label} cannot be absolute or contain traversal segments`)
  }

  const resolved = path.resolve(packRoot, relativePath)
  assertInside(packRoot, resolved, label)
  return resolved
}

async function assertNoSymlinks(packRoot, target, label) {
  assertInside(packRoot, target, label)
  const relativeParts = path.relative(packRoot, target).split(path.sep)
  let current = packRoot

  for (const part of relativeParts) {
    current = path.join(current, part)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) {
        fail(`${label} crosses a symbolic link: ${current}`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function requireRegularFile(packRoot, filePath, label) {
  await assertNoSymlinks(packRoot, filePath, label)
  const entry = await stat(filePath)
  if (!entry.isFile()) fail(`${label} is not a regular file`)
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value
}

function readVariantAssets(manifest, packRoot, variantName) {
  const variant = requireObject(manifest.variants?.[variantName], `variants.${variantName}`)
  const app = requireObject(variant.app, `variants.${variantName}.app`)
  const menuBar = requireObject(variant.menuBar, `variants.${variantName}.menuBar`)
  const previews = requireObject(variant.previews, `variants.${variantName}.previews`)
  const asset = (relativePath, label) =>
    resolveAsset(packRoot, relativePath, `${variantName}.${label}`)

  return {
    appSource: asset(app.sourceSvg, 'app.sourceSvg'),
    runtimePng: asset(app.runtimePng, 'app.runtimePng'),
    iconsetDirectory: asset(app.iconsetDirectory, 'app.iconsetDirectory'),
    icns: asset(app.icns, 'app.icns'),
    menuSource: asset(menuBar.sourceSvg, 'menuBar.sourceSvg'),
    menuPng1x: asset(menuBar.png1x, 'menuBar.png1x'),
    menuPng2x: asset(menuBar.png2x, 'menuBar.png2x'),
    templateSource: asset(menuBar.templateSourceSvg, 'menuBar.templateSourceSvg'),
    templatePng1x: asset(menuBar.templatePng1x, 'menuBar.templatePng1x'),
    templatePng2x: asset(menuBar.templatePng2x, 'menuBar.templatePng2x'),
    previewPng1x: asset(previews.png1x, 'previews.png1x'),
    previewPng2x: asset(previews.png2x, 'previews.png2x')
  }
}

async function renderPng(sourceBuffer, outputPath, size) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  await sharp(sourceBuffer, { density: 384 })
    .resize(size, size, { fit: 'fill' })
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toFile(outputPath)
}

// Renders app-icon rasters inset onto a transparent canvas per APP_ICON_INSET_RATIO,
// matching the ~82.8%-coverage convention macOS app icons follow. Menu-bar/template
// rasters keep using the full-bleed renderPng above — only app-icon call sites use this.
async function renderInsetPng(sourceBuffer, outputPath, size) {
  await mkdir(path.dirname(outputPath), { recursive: true })

  const artSize = Math.round(size * APP_ICON_INSET_RATIO.artwork)
  let left = Math.round(size * APP_ICON_INSET_RATIO.left)
  let top = Math.round(size * APP_ICON_INSET_RATIO.top)

  // Independent rounding of artSize/left/top can push the artwork past the canvas
  // edge by a pixel at small sizes. Clamp the offset (never shrink artSize, which
  // would change the coverage ratio) so the composite always lands fully in-canvas.
  if (left + artSize > size) left = size - artSize
  if (top + artSize > size) top = size - artSize
  left = Math.max(left, 0)
  top = Math.max(top, 0)

  const resized = await sharp(sourceBuffer, { density: 384 })
    .resize(artSize, artSize, { fit: 'fill' })
    .png()
    .toBuffer()

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: resized, left, top }])
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toFile(outputPath)
}

async function verifyPng(filePath, expectedSize) {
  const metadata = await sharp(filePath).metadata()
  if (
    metadata.format !== 'png' ||
    metadata.width !== expectedSize ||
    metadata.height !== expectedSize
  ) {
    fail(
      `Unexpected raster at ${filePath}: ${metadata.format} ${metadata.width}x${metadata.height}`
    )
  }
}

function appBuilderExecutable() {
  const binaryName = process.arch === 'arm64' ? 'app-builder_arm64' : 'app-builder_amd64'
  return path.join(REPOSITORY_ROOT, 'node_modules', 'app-builder-bin', 'mac', binaryName)
}

async function buildIcns(iconsetDirectory, runtimePng, outputPath) {
  await rm(outputPath, { force: true })

  try {
    await execFileAsync('/usr/bin/iconutil', [
      '--convert',
      'icns',
      '--output',
      outputPath,
      iconsetDirectory
    ])
    return 'iconutil'
  } catch (error) {
    // macOS 27 beta currently rejects even iconsets round-tripped from known-good
    // system/application ICNS files. Keep iconutil as the primary path, but allow
    // the already-installed electron-builder converter to keep packs reproducible.
    const fallbackDirectory = await mkdtemp(path.join(os.tmpdir(), 'orpheus-icon-pack-'))
    try {
      await execFileAsync(appBuilderExecutable(), [
        'icon',
        '--format=icns',
        `--out=${fallbackDirectory}`,
        `--root=${REPOSITORY_ROOT}`,
        `--input=${runtimePng}`
      ])
      await copyFile(path.join(fallbackDirectory, 'icon.icns'), outputPath)
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
      console.warn(
        `iconutil unavailable for ${path.basename(outputPath)} (${reason}); used app-builder`
      )
      return 'app-builder'
    } finally {
      await rm(fallbackDirectory, { force: true, recursive: true })
    }
  }
}

async function buildVariant(packRoot, manifest, variantName) {
  const assets = readVariantAssets(manifest, packRoot, variantName)
  const outputPaths = [
    assets.runtimePng,
    assets.iconsetDirectory,
    assets.icns,
    assets.menuPng1x,
    assets.menuPng2x,
    assets.templatePng1x,
    assets.templatePng2x,
    assets.previewPng1x,
    assets.previewPng2x
  ]

  await Promise.all([
    requireRegularFile(packRoot, assets.appSource, `${variantName} app source`),
    requireRegularFile(packRoot, assets.menuSource, `${variantName} menu-bar source`),
    requireRegularFile(packRoot, assets.templateSource, `${variantName} template source`),
    ...outputPaths.map((outputPath) =>
      assertNoSymlinks(packRoot, outputPath, `${variantName} output`)
    )
  ])

  const [appSource, menuSource, templateSource] = await Promise.all([
    readFile(assets.appSource),
    readFile(assets.menuSource),
    readFile(assets.templateSource)
  ])
  const [appMetadata, menuMetadata, templateMetadata] = await Promise.all([
    sharp(appSource).metadata(),
    sharp(menuSource).metadata(),
    sharp(templateSource).metadata()
  ])

  if (appMetadata.width !== 1024 || appMetadata.height !== 1024) {
    fail(`${variantName} app source must declare a 1024x1024 canvas`)
  }
  for (const [label, metadata] of [
    ['menu-bar', menuMetadata],
    ['template', templateMetadata]
  ]) {
    if (metadata.width !== 64 || metadata.height !== 64) {
      fail(`${variantName} ${label} source must declare a 64x64 canvas`)
    }
  }

  await rm(assets.iconsetDirectory, { force: true, recursive: true })
  await mkdir(assets.iconsetDirectory, { recursive: true })

  const rasterJobs = [
    renderInsetPng(appSource, assets.runtimePng, 1024),
    renderInsetPng(appSource, assets.previewPng1x, 256),
    renderInsetPng(appSource, assets.previewPng2x, 512),
    renderPng(menuSource, assets.menuPng1x, 32),
    renderPng(menuSource, assets.menuPng2x, 64),
    renderPng(templateSource, assets.templatePng1x, 18),
    renderPng(templateSource, assets.templatePng2x, 36),
    ...ICONSET_FRAMES.map(([filename, size]) =>
      renderInsetPng(appSource, path.join(assets.iconsetDirectory, filename), size)
    )
  ]
  await Promise.all(rasterJobs)

  const icnsBuilder = await buildIcns(assets.iconsetDirectory, assets.runtimePng, assets.icns)

  await Promise.all([
    verifyPng(assets.runtimePng, 1024),
    verifyPng(assets.previewPng1x, 256),
    verifyPng(assets.previewPng2x, 512),
    verifyPng(assets.menuPng1x, 32),
    verifyPng(assets.menuPng2x, 64),
    verifyPng(assets.templatePng1x, 18),
    verifyPng(assets.templatePng2x, 36),
    ...ICONSET_FRAMES.map(([filename, size]) =>
      verifyPng(path.join(assets.iconsetDirectory, filename), size)
    )
  ])

  const icnsMetadata = await stat(assets.icns)
  if (!icnsMetadata.isFile() || icnsMetadata.size === 0) {
    fail(`${variantName} ICNS was not generated`)
  }

  return {
    variantName,
    rasterCount: rasterJobs.length,
    icnsBytes: icnsMetadata.size,
    icnsBuilder
  }
}

async function main() {
  const packId = process.argv[2]
  if (!packId || process.argv.length > 3) {
    fail('Usage: node scripts/build-icon-pack.mjs <pack-id>')
  }
  assertPackId(packId)

  const catalogRoot = await realpath(CATALOG_ROOT)
  const packRoot = path.join(catalogRoot, packId)
  assertInside(catalogRoot, packRoot, 'Pack root')
  const packEntry = await lstat(packRoot)
  if (!packEntry.isDirectory() || packEntry.isSymbolicLink()) {
    fail(`Pack root must be a real directory: ${packRoot}`)
  }

  const manifestPath = path.join(packRoot, 'manifest.json')
  await requireRegularFile(packRoot, manifestPath, 'Pack manifest')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

  if (manifest.schemaVersion !== 2) fail('Only icon-pack schemaVersion 2 is supported')
  if (manifest.id !== packId) {
    fail(`Manifest ID "${manifest.id}" does not match pack directory "${packId}"`)
  }
  if (manifest.modeFallbacks?.worktree !== 'development') {
    fail('modeFallbacks.worktree must resolve to development')
  }

  const results = []
  for (const variantName of VARIANT_NAMES) {
    results.push(await buildVariant(packRoot, manifest, variantName))
  }

  for (const result of results) {
    console.log(
      `built ${packId}/${result.variantName}: ${result.rasterCount} PNGs, ICNS ${result.icnsBytes} bytes (${result.icnsBuilder})`
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
