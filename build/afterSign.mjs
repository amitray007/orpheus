/**
 * electron-builder afterSign hook — unified ad-hoc re-sign for macOS 15+
 *
 * WHY THIS EXISTS:
 *   electron-builder's per-component ad-hoc signing leaves inner frameworks
 *   (Electron Framework.framework, Squirrel.framework, etc.) with a Team ID
 *   that differs from the outer application binary. macOS 15+ enforces that
 *   every component in a bundle shares the same Team ID, and refuses to load
 *   any component where the mapping process and the mapped file have different
 *   Team IDs — producing a dyld error at launch.
 *
 *   The fix is a whole-bundle re-sign with `codesign --force --deep --sign -`
 *   AFTER electron-builder's own per-component signing pass, so that a single
 *   ad-hoc identity unifies all Team IDs across the bundle. This mirrors the
 *   same codesign call in scripts/install-mac.mjs (local install path), but
 *   fires at the right seam in CI so the shipped .dmg is also clean.
 *
 * TIMING:
 *   electron-builder hook order: afterPack → (sign per-component) → afterSign
 *   → (build dmg/zip target). Running here (afterSign) means we re-sign AFTER
 *   electron-builder's own signing pass and BEFORE the dmg is packaged, which
 *   is exactly the right window — our unified sign is what ends up in the dmg.
 */

import { execSync } from 'node:child_process'
import path from 'node:path'

export default async function afterSign(context) {
  // Only macOS needs this; skip other platforms.
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const productFilename = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${productFilename}.app`)

  console.log(`[afterSign] re-signing ${appPath} (ad-hoc, unified Team IDs for macOS 15+)`)

  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' })
    console.log(`[afterSign] re-sign complete`)
  } catch (err) {
    console.error(`[afterSign] codesign failed: ${err.message}`)
    throw err
  }
}
