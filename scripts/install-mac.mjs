#!/usr/bin/env node
/**
 * Install the built Orpheus .app bundle to /Applications/.
 *
 * Usage:
 *   node scripts/install-mac.mjs --dev       # dev     (dist-dev/     -> /Applications/Orpheus Dev.app)
 *   node scripts/install-mac.mjs --wt        # wt      (dist-wt/      -> /Applications/Orpheus WT.app)
 *   node scripts/install-mac.mjs --nightly   # nightly (dist-nightly/ -> /Applications/Orpheus Nightly.app)
 *   ORPHEUS_ALLOW_PROD_INSTALL=1 node scripts/install-mac.mjs   # prod (dist/ -> /Applications/Orpheus.app)
 *
 * Local development installs the DEV, WT, or NIGHTLY variant only. The production variant lives
 * exclusively in /Applications/Orpheus.app and is owned by the Homebrew cask /
 * CI release pipeline — never by a local build. Installing prod locally would
 * clobber that managed copy, so it is locked behind ORPHEUS_ALLOW_PROD_INSTALL=1
 * and must be invoked deliberately. The agent/build loop never sets this flag.
 * Nightly, like dev/wt, is an isolated app variant (own bundle id, own data
 * dir) so it is allowed WITHOUT the prod guard.
 */
import { execFileSync, execSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('[install-mac] skipping: not macOS')
  process.exit(0)
}

const isDev = process.argv.includes('--dev')
const isWt = process.argv.includes('--wt')
const isNightly = process.argv.includes('--nightly')

// Guard: prod local-install is opt-in only. Without the flag, refuse rather than
// overwrite the Homebrew/CI-managed /Applications/Orpheus.app. Dev, WT, and
// Nightly installs are always allowed — they target isolated app variants.
if (!isDev && !isWt && !isNightly && process.env.ORPHEUS_ALLOW_PROD_INSTALL !== '1') {
  console.error(
    '[install-mac] refusing to install the PRODUCTION bundle locally.\n' +
      '  Production Orpheus.app is managed by Homebrew / CI — a local build must not clobber it.\n' +
      '  Use `bun run build:dev` (or `build:unpack`) to build + install Orpheus Dev.app instead.\n' +
      '  To override deliberately: ORPHEUS_ALLOW_PROD_INSTALL=1 bun run build:mac'
  )
  process.exit(1)
}
const tag = isWt
  ? '[install-mac-wt]'
  : isNightly
    ? '[install-mac-nightly]'
    : isDev
      ? '[install-mac-dev]'
      : '[install-mac]'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(
  projectRoot,
  isWt ? 'dist-wt' : isNightly ? 'dist-nightly' : isDev ? 'dist-dev' : 'dist'
)

// Tell Spotlight to skip dist/ so the build-output .app doesn't appear
// alongside the real one in /Applications when searching.
if (existsSync(distDir)) {
  const marker = resolve(distDir, '.metadata_never_index')
  if (!existsSync(marker)) {
    closeSync(openSync(marker, 'w'))
  }
}

const findAppBundle = (dir) => {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (entry.endsWith('.app')) return full
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      const found = findAppBundle(full)
      if (found) return found
    }
  }
  return null
}

const appBundle = findAppBundle(distDir)
if (!appBundle) {
  console.error(`${tag} no .app found under ${distDir}. Did the build succeed?`)
  process.exit(1)
}

const appName = appBundle.split('/').pop()
const target = `/Applications/${appName}`

// Symlink dir for the local-only (non-brew) CLI links created below. Chosen
// over /opt/homebrew/bin deliberately: that dir is Homebrew-owned (it holds
// the `orpheus`/`orpheus-nightly` links Homebrew's `binary` stanza manages
// for the casks — see scripts/orpheus-cask.template.rb) and may not even be
// writable without sudo on an Intel Mac (/usr/local/bin). ~/.local/bin is
// user-owned, needs no sudo, and is the conventional per-user bin dir many
// shells (and tools like `pipx`/`cargo`) already add to PATH.
const LOCAL_BIN_DIR = resolve(homedir(), '.local/bin')

/**
 * Symlink `resources/bin/orpheus` (this bundle's copy) into LOCAL_BIN_DIR
 * under `linkName`, so it can be invoked without going through the
 * per-workspace-terminal PATH injection. The shim itself needs no
 * variant-specific logic — it resolves ORPHEUS_INVOKED_VARIANT from which
 * Electron binary is physically next to it inside `appTarget`, regardless of
 * what this symlink is named (see resources/bin/orpheus's header comment and
 * packages/orpheus-cli/src/paths.ts's "CROSS-VARIANT TALK GUARD").
 *
 * Idempotent: re-points the link on every install so a rebuild self-heals
 * it. Never touches a `orpheus` link — brew owns that name exclusively for
 * the prod cask; this function is only ever called with `orpheus-dev` /
 * `orpheus-wt`. Failures (read-only dir, permissions) are warnings, not
 * install failures — a missing CLI shortcut should never block a build.
 */
function linkCliShim(appTarget, linkName, logTag) {
  const shimSource = resolve(appTarget, 'Contents/Resources/bin/orpheus')
  const linkPath = resolve(LOCAL_BIN_DIR, linkName)

  if (!existsSync(shimSource)) {
    console.warn(`${logTag} skipping ${linkName} symlink: shim not found at ${shimSource}`)
    return
  }

  try {
    if (!existsSync(LOCAL_BIN_DIR)) {
      mkdirSync(LOCAL_BIN_DIR, { recursive: true })
    }

    // Re-point unconditionally so a stale link (e.g. left over from a moved
    // dist dir) is corrected rather than silently kept.
    if (lstatSync(linkPath, { throwIfNoEntry: false })) {
      if (readlinkSync(linkPath) === shimSource) {
        console.log(`${logTag} ${linkName} already points at ${shimSource}`)
        return
      }
      unlinkSync(linkPath)
    }
    symlinkSync(shimSource, linkPath)
    console.log(`${logTag} linked ${linkPath} -> ${shimSource}`)

    const pathDirs = (process.env.PATH ?? '').split(':')
    if (!pathDirs.includes(LOCAL_BIN_DIR)) {
      console.log(
        `${logTag} ${LOCAL_BIN_DIR} is not on PATH — add ` +
          `'export PATH="${LOCAL_BIN_DIR}:$PATH"' to your shell profile to use \`${linkName}\`.`
      )
    }
  } catch (err) {
    console.warn(`${logTag} could not create ${linkName} symlink: ${err.message}`)
  }
}

const isAppRunning = () => {
  try {
    execFileSync('pgrep', ['-fl', `/Applications/${appName}/Contents/MacOS/`], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

if (existsSync(target) && isAppRunning()) {
  console.error(`${tag} ${appName} is currently running. Quit it (⌘Q) and re-run the build.`)
  process.exit(1)
}

try {
  // electron-builder's ad-hoc signing leaves inner frameworks with mismatched
  // Team IDs. macOS 15+ refuses to load them, so we re-sign the whole bundle
  // as one ad-hoc unit to normalise Team IDs across all components.
  console.log(`${tag} re-signing ${appBundle} (ad-hoc, unified Team IDs)`)
  execSync(`codesign --force --deep --sign - "${appBundle}"`, { stdio: 'inherit' })
  execSync(`codesign --verify --deep --strict "${appBundle}"`, { stdio: 'pipe' })

  if (existsSync(target)) {
    console.log(`${tag} removing existing ${target}`)
    rmSync(target, { recursive: true, force: true })
  }
  console.log(`${tag} installing ${appBundle} -> ${target}`)
  execSync(`/usr/bin/ditto "${appBundle}" "${target}"`, { stdio: 'inherit' })

  // Remove the build-output bundle so there's only ever one copy on disk
  // after install — avoids stale builds appearing in Spotlight / Finder.
  console.log(`${tag} cleaning ${distDir}`)
  rmSync(distDir, { recursive: true, force: true })

  console.log(`${tag} done. Open with: open "${target}"`)

  // Dev and WT are local-only variants (never shipped via the Homebrew cask,
  // which is how prod/nightly get their `orpheus`/`orpheus-nightly` PATH
  // links — see scripts/orpheus-cask.template.rb and
  // orpheus-nightly-cask.template.rb). Without a brew-managed link, `orpheus
  // tui` from a dev shell or `docs/REMOTE_ACCESS.md`'s Termius setup has no
  // way to reach them, so give each its own symlink here, refreshed on every
  // install so a rebuild self-heals it.
  if (isDev) linkCliShim(target, 'orpheus-dev', tag)
  if (isWt) linkCliShim(target, 'orpheus-wt', tag)
} catch (err) {
  console.error(`${tag} failed: ${err.message}`)
  process.exit(1)
}
