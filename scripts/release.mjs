#!/usr/bin/env node
/**
 * Release pipeline for Orpheus → private Homebrew tap.
 *
 * What it does (in order):
 *   1. Reads the version from package.json (must be bumped before running).
 *   2. Verifies the tag doesn't already exist on the source repo.
 *   3. Builds the native addon, runs typecheck + electron-vite, then
 *      electron-builder --mac to produce a .dmg in dist/.
 *   4. Computes the .dmg sha256.
 *   5. Creates a GitHub release `v<version>` on amitray007/orpheus and
 *      uploads the .dmg as the release asset.
 *   6. Renders scripts/orpheus-cask.template.rb with version + sha256
 *      and writes it to <TAP_REPO_PATH>/Casks/orpheus.rb, then commits
 *      and pushes from that checkout.
 *   7. Prints the install/upgrade incantation for the user.
 *
 * Prerequisites:
 *   - gh CLI auth'd with `repo` scope (verify with `gh auth status`).
 *   - The tap repo is cloned at TAP_REPO_PATH (override with $ORPHEUS_TAP_PATH).
 *   - Orpheus quit (a running instance can hold .node files).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_REPO = 'amitray007/orpheus'
const TAP_REPO_PATH =
  process.env.ORPHEUS_TAP_PATH ?? resolve(projectRoot, '..', 'homebrew-tap')
const CASK_RELPATH = 'Casks/orpheus.rb'

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`)
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: projectRoot, ...opts })
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with status ${result.status}`)
  }
}

const ghJson = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf-8', cwd: projectRoot })
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 1. Version + preflight
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8'))
const version = pkg.version
const tag = `v${version}`
console.log(`[release] preparing ${tag}`)

if (!existsSync(TAP_REPO_PATH)) {
  console.error(`[release] tap repo not found at ${TAP_REPO_PATH}`)
  console.error(
    `[release] clone it first: git clone git@github.com:amitray007/homebrew-tap.git ${TAP_REPO_PATH}`
  )
  process.exit(1)
}

const existing = ghJson(['release', 'view', tag, '--repo', SOURCE_REPO, '--json', 'tagName'])
if (existing) {
  console.error(
    `[release] release ${tag} already exists on ${SOURCE_REPO}. Bump package.json#version first.`
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 2. Build .dmg
// ---------------------------------------------------------------------------

run('bun', ['run', 'build:native'])
run('bun', ['run', 'build'])
run('bunx', ['electron-builder', '--mac'])

const dmgPath = resolve(projectRoot, 'dist', `orpheus-${version}.dmg`)
if (!existsSync(dmgPath)) {
  console.error(`[release] no .dmg at ${dmgPath} — did electron-builder produce a different name?`)
  process.exit(1)
}
const dmgSize = statSync(dmgPath).size
console.log(`[release] built ${dmgPath} (${(dmgSize / 1024 / 1024).toFixed(1)} MiB)`)

// ---------------------------------------------------------------------------
// 3. sha256
// ---------------------------------------------------------------------------

const sha256 = createHash('sha256').update(readFileSync(dmgPath)).digest('hex')
console.log(`[release] sha256 ${sha256}`)

// ---------------------------------------------------------------------------
// 4. GitHub release on source repo
// ---------------------------------------------------------------------------

run('gh', [
  'release',
  'create',
  tag,
  dmgPath,
  '--repo',
  SOURCE_REPO,
  '--title',
  tag,
  '--notes',
  `Orpheus ${tag}\n\nInstall:\n\n\`\`\`\nbrew tap amitray007/tap\nbrew install --cask orpheus\n\`\`\``
])

// ---------------------------------------------------------------------------
// 5. Write + push cask to the local tap checkout
// ---------------------------------------------------------------------------

const template = readFileSync(resolve(projectRoot, 'scripts/orpheus-cask.template.rb'), 'utf-8')
const rendered = template.replace(/\{\{VERSION\}\}/g, version).replace(/\{\{SHA256\}\}/g, sha256)
const caskAbs = resolve(TAP_REPO_PATH, CASK_RELPATH)

mkdirSync(dirname(caskAbs), { recursive: true })
writeFileSync(caskAbs, rendered, 'utf-8')
console.log(`[release] wrote ${caskAbs}`)

// Pull first to avoid pushing on top of a behind branch.
run('git', ['pull', '--ff-only'], { cwd: TAP_REPO_PATH })
run('git', ['add', CASK_RELPATH], { cwd: TAP_REPO_PATH })
run('git', ['commit', '-m', `orpheus: bump to ${version}`], { cwd: TAP_REPO_PATH })
run('git', ['push', 'origin', 'HEAD'], { cwd: TAP_REPO_PATH })

// ---------------------------------------------------------------------------
// 6. Done
// ---------------------------------------------------------------------------

console.log(`
[release] ${tag} shipped.

First-time install on a new machine:
  export HOMEBREW_GITHUB_API_TOKEN="$(gh auth token)"   # private tap auth
  brew tap amitray007/tap
  brew install --cask orpheus

Upgrade after future releases:
  brew upgrade --cask orpheus
`)

// Clean up dist/ now that the upload is complete.
try {
  execFileSync('rm', ['-rf', resolve(projectRoot, 'dist')], { stdio: 'inherit' })
} catch (err) {
  console.warn(`[release] failed to clean dist/: ${err.message}`)
}
