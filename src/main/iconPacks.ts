// ---------------------------------------------------------------------------
// src/main/iconPacks.ts
//
// Icon-pack discovery + live-apply service for Settings > General "App icon".
//
// Reads the on-disk catalog at resources/icon-sets/ (see its README.md and
// pack.schema.json for the full contract this module enforces at runtime):
//   - Enumerates immediate child directories of the catalog root.
//   - Reads + validates each manifest.json against the schemaVersion 2
//     contract (structural checks only — no external JSON-schema lib is a
//     repo dependency, so validation is hand-rolled against the same shape
//     pack.schema.json documents).
//   - Rejects (logs + skips, never throws) a pack with: an unparsable/
//     invalid manifest, a duplicate `id`, or any referenced asset that either
//     doesn't resolve inside the pack root (path traversal / absolute path)
//     or doesn't exist on disk.
//   - Resolves the current build variant (production/development/nightly/
//     worktree->modeFallbacks.worktree) and hands back only that variant's
//     assets for each valid pack — the renderer never sees the others.
//
// Persistence: only the pack `id` is ever stored (see uiState.ts's
// iconPackId column) — never a path or version, per the README's explicit
// contract note. Unknown/missing ids fall back to 'legacy', then to the
// first valid pack if legacy itself is absent, matching the Task 2
// requirement.
//
// Live apply: app.dock.setIcon() (macOS-only, guarded) updates the running
// Dock icon immediately from the variant's app/app.png (the manifest's
// `runtimePng`). The packaged .icns (Finder/Applications icon) can NOT be
// changed at runtime — see applyIconPackToDock's doc comment.
// ---------------------------------------------------------------------------

import { app, nativeImage } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { isDev, isWorktreeBuild, isNightly } from './appMode'

// ---------------------------------------------------------------------------
// Manifest shape (schemaVersion 2) — mirrors resources/icon-sets/pack.schema.json
// ---------------------------------------------------------------------------

type AssetVariantKind = 'production' | 'development' | 'nightly'

interface AppAssets {
  sourceSvg: string
  runtimePng: string
  iconsetDirectory: string
  icns: string
}

interface MenuBarAssets {
  sourceSvg: string
  png1x: string
  png2x: string
  templateSourceSvg: string
  templatePng1x: string
  templatePng2x: string
}

interface PreviewAssets {
  png1x: string
  png2x: string
}

interface ManifestVariant {
  app: AppAssets
  menuBar: MenuBarAssets
  previews: PreviewAssets
}

interface PackManifest {
  schemaVersion: 2
  id: string
  name: string
  description: string
  version: string
  variants: Record<AssetVariantKind, ManifestVariant>
  modeFallbacks: { worktree: 'development' }
}

// A pack that passed validation, with every asset path already resolved to
// an absolute, in-bounds filesystem path (not just the raw manifest strings).
export interface ResolvedIconPack {
  id: string
  name: string
  description: string
  root: string
  variants: Record<AssetVariantKind, ResolvedVariantAssets>
}

interface ResolvedVariantAssets {
  app: { runtimePng: string; icns: string }
  previews: { png1x: string; png2x: string }
}

// ---------------------------------------------------------------------------
// Catalog root resolution — packaged vs dev layout.
//
// Mirrors the pattern in src/main/orpheusSurfaceAdapter.ts's
// loadOrpheusSurface() / index.ts's loadTerminalAddon(): app.isPackaged picks
// between process.resourcesPath (Contents/Resources/icon-sets, bundled via
// electron-builder*.yml's extraResources) and the repo-relative resources/
// dir (dev, run from the built main/index.js under out/main/).
// ---------------------------------------------------------------------------

function getCatalogRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon-sets')
    : path.join(__dirname, '../../resources/icon-sets')
}

// ---------------------------------------------------------------------------
// Build-mode -> manifest variant mapping (Task 1 requirement)
// ---------------------------------------------------------------------------

function currentVariantKind(): AssetVariantKind {
  if (isWorktreeBuild) return 'development' // modeFallbacks.worktree is schema-locked to 'development'
  if (isNightly) return 'nightly'
  if (isDev) return 'development'
  return 'production'
}

// ---------------------------------------------------------------------------
// Path-traversal defense — never trust the manifest. Every asset path must
// resolve to a real file that stays inside the pack's own root directory.
// Rejects absolute paths and `..` segments, and (like files.ts's
// resolveExistingInside) re-checks via realpath so a symlink can't be used to
// escape the pack root either.
// ---------------------------------------------------------------------------

async function resolveAssetInside(packRoot: string, relPath: string): Promise<string | null> {
  if (typeof relPath !== 'string' || relPath.length === 0) return null
  if (path.isAbsolute(relPath)) return null

  const lexicalAbs = path.resolve(packRoot, relPath)
  const lexicalRel = path.relative(packRoot, lexicalAbs)
  if (
    lexicalRel === '' ||
    lexicalRel === '..' ||
    lexicalRel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRel)
  ) {
    return null
  }

  try {
    const [root, candidate] = await Promise.all([fs.realpath(packRoot), fs.realpath(lexicalAbs)])
    const rel = path.relative(root, candidate)
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return null
    }
    const stat = await fs.stat(candidate)
    if (!stat.isFile()) return null
    return candidate
  } catch {
    return null // missing asset, dangling symlink, or unreadable — reject
  }
}

// ---------------------------------------------------------------------------
// Manifest structural validation — hand-rolled against pack.schema.json's
// shape (no ajv/json-schema dependency in this repo). Returns a typed
// manifest or null; never throws.
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function validateAppAssets(v: unknown): v is AppAssets {
  return (
    isPlainObject(v) &&
    isNonEmptyString(v.sourceSvg) &&
    isNonEmptyString(v.runtimePng) &&
    isNonEmptyString(v.iconsetDirectory) &&
    isNonEmptyString(v.icns)
  )
}

function validateMenuBarAssets(v: unknown): v is MenuBarAssets {
  return (
    isPlainObject(v) &&
    isNonEmptyString(v.sourceSvg) &&
    isNonEmptyString(v.png1x) &&
    isNonEmptyString(v.png2x) &&
    isNonEmptyString(v.templateSourceSvg) &&
    isNonEmptyString(v.templatePng1x) &&
    isNonEmptyString(v.templatePng2x)
  )
}

function validatePreviewAssets(v: unknown): v is PreviewAssets {
  return isPlainObject(v) && isNonEmptyString(v.png1x) && isNonEmptyString(v.png2x)
}

function validateVariant(v: unknown): v is ManifestVariant {
  return (
    isPlainObject(v) &&
    validateAppAssets(v.app) &&
    validateMenuBarAssets(v.menuBar) &&
    validatePreviewAssets(v.previews)
  )
}

/** Structural-only validation of a parsed manifest.json. Returns a reason
 *  string on failure (for logging) or null on success. */
function validateManifestShape(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'manifest is not an object'
  if (raw.schemaVersion !== 2) return `unsupported schemaVersion: ${String(raw.schemaVersion)}`
  if (!isNonEmptyString(raw.id) || !ID_PATTERN.test(raw.id)) return 'invalid or missing id'
  if (!isNonEmptyString(raw.name)) return 'missing name'
  if (!isNonEmptyString(raw.description)) return 'missing description'
  if (!isNonEmptyString(raw.version)) return 'missing version'
  if (!isPlainObject(raw.variants)) return 'missing variants'
  for (const kind of ['production', 'development', 'nightly'] as const) {
    if (!validateVariant(raw.variants[kind])) return `invalid or missing variants.${kind}`
  }
  if (!isPlainObject(raw.modeFallbacks) || raw.modeFallbacks.worktree !== 'development') {
    return 'invalid or missing modeFallbacks.worktree'
  }
  return null
}

// ---------------------------------------------------------------------------
// Per-pack loading — reads manifest.json, validates shape, resolves +
// verifies every referenced asset for all three variants stays inside the
// pack root and exists. A pack is rejected (logged, skipped) as a whole unit
// if ANY of these fail — never partially loaded.
// ---------------------------------------------------------------------------

async function resolveVariantAssets(
  packRoot: string,
  variant: ManifestVariant
): Promise<ResolvedVariantAssets | string> {
  const [runtimePng, icns, preview1x, preview2x] = await Promise.all([
    resolveAssetInside(packRoot, variant.app.runtimePng),
    resolveAssetInside(packRoot, variant.app.icns),
    resolveAssetInside(packRoot, variant.previews.png1x),
    resolveAssetInside(packRoot, variant.previews.png2x)
  ])
  if (!runtimePng)
    return `app.runtimePng escapes pack root or is missing: ${variant.app.runtimePng}`
  if (!icns) return `app.icns escapes pack root or is missing: ${variant.app.icns}`
  if (!preview1x) return `previews.png1x escapes pack root or is missing: ${variant.previews.png1x}`
  if (!preview2x) return `previews.png2x escapes pack root or is missing: ${variant.previews.png2x}`
  // menuBar assets are validated for shape only (Task 4 explicitly defers
  // wiring them — no Tray/menu-bar consumer exists yet in this app) but we
  // still don't need to resolve them on disk here; skipping that I/O keeps
  // discovery fast without weakening the security contract (menuBar assets
  // are never read into memory or exposed to the renderer).
  return {
    app: { runtimePng, icns },
    previews: { png1x: preview1x, png2x: preview2x }
  }
}

async function loadPack(packDir: string): Promise<ResolvedIconPack | string> {
  const manifestPath = path.join(packDir, 'manifest.json')
  let raw: unknown
  try {
    const text = await fs.readFile(manifestPath, 'utf8')
    raw = JSON.parse(text)
  } catch (err) {
    return `unreadable or invalid JSON manifest: ${err instanceof Error ? err.message : String(err)}`
  }

  const shapeError = validateManifestShape(raw)
  if (shapeError) return shapeError
  const manifest = raw as PackManifest

  const packRoot = await fs.realpath(packDir).catch(() => packDir)

  const [production, development, nightly] = await Promise.all([
    resolveVariantAssets(packRoot, manifest.variants.production),
    resolveVariantAssets(packRoot, manifest.variants.development),
    resolveVariantAssets(packRoot, manifest.variants.nightly)
  ])
  if (typeof production === 'string') return `production variant: ${production}`
  if (typeof development === 'string') return `development variant: ${development}`
  if (typeof nightly === 'string') return `nightly variant: ${nightly}`

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    root: packRoot,
    variants: { production, development, nightly }
  }
}

// ---------------------------------------------------------------------------
// Catalog discovery — enumerates immediate child directories, loads +
// validates each, rejects duplicate ids (first one wins, logs the rest).
// Total / never throws: any per-pack failure is logged and that pack is
// skipped; a totally missing/unreadable catalog root resolves to [].
// ---------------------------------------------------------------------------

let cachedCatalog: ResolvedIconPack[] | null = null

async function discoverIconPacksUncached(): Promise<ResolvedIconPack[]> {
  const root = getCatalogRoot()
  let entries: string[]
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true })
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (err) {
    console.warn(
      '[iconPacks] catalog root unreadable, no packs available:',
      root,
      err instanceof Error ? err.message : String(err)
    )
    return []
  }

  const seenIds = new Set<string>()
  const packs: ResolvedIconPack[] = []
  for (const name of entries) {
    const packDir = path.join(root, name)
    const result = await loadPack(packDir)
    if (typeof result === 'string') {
      console.warn(`[iconPacks] skipping pack "${name}": ${result}`)
      continue
    }
    if (seenIds.has(result.id)) {
      console.warn(
        `[iconPacks] skipping pack "${name}": duplicate id "${result.id}" (already loaded from another directory)`
      )
      continue
    }
    seenIds.add(result.id)
    packs.push(result)
  }
  return packs
}

/** Enumerate + validate the on-disk icon-pack catalog. Cached after the first
 *  call — the catalog is static bundled content for the lifetime of the
 *  process (a new build is required to add/remove/modify packs). */
export async function discoverIconPacks(): Promise<ResolvedIconPack[]> {
  if (cachedCatalog) return cachedCatalog
  cachedCatalog = await discoverIconPacksUncached()
  return cachedCatalog
}

/** Test-only escape hatch so verification fixtures can point discovery at a
 *  temp catalog dir without mutating global app state. Not used by
 *  production code paths (which always call discoverIconPacks()). */
export async function discoverIconPacksAt(catalogRoot: string): Promise<ResolvedIconPack[]> {
  const dirents = await fs.readdir(catalogRoot, { withFileTypes: true }).catch(() => [])
  const seenIds = new Set<string>()
  const packs: ResolvedIconPack[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const packDir = path.join(catalogRoot, dirent.name)
    const result = await loadPack(packDir)
    if (typeof result === 'string') {
      console.warn(`[iconPacks] skipping pack "${dirent.name}": ${result}`)
      continue
    }
    if (seenIds.has(result.id)) {
      console.warn(`[iconPacks] skipping pack "${dirent.name}": duplicate id "${result.id}"`)
      continue
    }
    seenIds.add(result.id)
    packs.push(result)
  }
  return packs
}

// ---------------------------------------------------------------------------
// Fallback resolution — Task 2: unknown/missing persisted id falls back to
// 'legacy', then to the first valid pack if legacy itself is absent.
// ---------------------------------------------------------------------------

export function resolveSelectedPack(
  packs: ResolvedIconPack[],
  persistedId: string
): ResolvedIconPack | null {
  const exact = packs.find((p) => p.id === persistedId)
  if (exact) return exact
  const legacy = packs.find((p) => p.id === 'legacy')
  if (legacy) return legacy
  return packs[0] ?? null
}

// ---------------------------------------------------------------------------
// Data-URI preview loading — the renderer sandbox cannot load main-process
// file paths directly, so previews/preview@2x.png is read and inlined as a
// data: URI (same approach as avatarCache.ts / files.ts's readImageContents
// — see that precedent rather than introducing a new registered protocol).
// ---------------------------------------------------------------------------

async function loadPreviewDataUri(pngPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(pngPath)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** Build the Settings-picker payload: every valid pack's CURRENT-variant
 *  preview (as a data URI) + name/description, plus which id is selected
 *  (already fallback-resolved). */
export async function getIconPackCatalog(persistedId: string): Promise<{
  packs: { id: string; name: string; description: string; previewDataUri: string | null }[]
  selectedId: string
}> {
  const packs = await discoverIconPacks()
  const variantKind = currentVariantKind()
  const selected = resolveSelectedPack(packs, persistedId)

  const summaries = await Promise.all(
    packs.map(async (pack) => ({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      previewDataUri: await loadPreviewDataUri(pack.variants[variantKind].previews.png2x)
    }))
  )

  return { packs: summaries, selectedId: selected?.id ?? 'legacy' }
}

// ---------------------------------------------------------------------------
// Live apply — Task 3. Dock icon updates immediately via
// app.dock.setIcon(nativeImage.createFromPath(...)); the packaged .icns
// (Finder/Applications icon) is baked in at build time and CANNOT be changed
// at runtime — callers (IPC handler + Settings UI copy) must not claim
// otherwise.
// ---------------------------------------------------------------------------

/** Apply a pack's current-variant runtime PNG to the live Dock icon.
 *  No-op (never throws) on non-macOS or when app.dock is unavailable —
 *  Electron's Dock API is macOS-only. */
export function applyIconPackToDock(pack: ResolvedIconPack): void {
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    const variantKind = currentVariantKind()
    const image = nativeImage.createFromPath(pack.variants[variantKind].app.runtimePng)
    if (image.isEmpty()) {
      console.warn('[iconPacks] runtimePng loaded empty image, skipping dock apply:', pack.id)
      return
    }
    app.dock.setIcon(image)
  } catch (err) {
    console.error(
      '[iconPacks] failed to apply dock icon:',
      err instanceof Error ? err.message : err
    )
  }
}

/** Startup + on-selection entry point: resolve the persisted pack id (with
 *  fallback) against the live catalog and apply it to the Dock. Total —
 *  swallows all errors so a missing/corrupt catalog never blocks boot. */
export async function applyPersistedIconPack(persistedId: string): Promise<void> {
  try {
    const packs = await discoverIconPacks()
    const selected = resolveSelectedPack(packs, persistedId)
    if (selected) applyIconPackToDock(selected)
  } catch (err) {
    console.error(
      '[iconPacks] failed to apply persisted icon pack:',
      err instanceof Error ? err.message : err
    )
  }
}
