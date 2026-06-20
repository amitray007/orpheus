import { shell, clipboard } from 'electron'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'

// ---------------------------------------------------------------------------
// User-shell PATH resolution
// Finder-launched Electron apps inherit a stripped PATH that omits Homebrew
// and most user-installed bins. Shelling out to the user's login+interactive
// shell once on app start lets the rest of the process resolve `claude`,
// `gh`, etc. the same way they do in Terminal.app.
// ---------------------------------------------------------------------------

let shellPathPromise: Promise<string> | null = null
// Settled value of shellPathPromise — populated when the promise resolves so
// terminal:mount can read it synchronously without awaiting.
let resolvedShellPath: string | null = null

/**
 * Returns the cached shell PATH string if the initial resolution has already
 * completed; null if resolution is still pending (e.g. the very first terminal
 * mount fires before the startup spawn finishes — rare in practice); or empty
 * string if resolution failed (SHELL not set, rejected path, or spawn error).
 */
export function getCachedShellPath(): string | null {
  return resolvedShellPath
}

export function getUserShellPath(): Promise<string> {
  if (shellPathPromise !== null) return shellPathPromise
  const userShell = process.env['SHELL']
  if (!userShell) {
    console.warn('[shellHelpers] SHELL not set; user PATH cannot be derived')
    shellPathPromise = Promise.resolve('')
    return shellPathPromise
  }
  // Validate that SHELL is an absolute path with no shell metacharacters
  // before spawning — defence in depth in case the env is tampered with.
  // execFile (vs exec) already avoids shell interpretation of the command
  // string, but the binary path itself goes to the OS verbatim.
  if (!/^\/[\w./@+-]+$/.test(userShell)) {
    console.warn('[shellHelpers] SHELL value rejected (not a clean absolute path):', userShell)
    shellPathPromise = Promise.resolve('')
    return shellPathPromise
  }
  shellPathPromise = new Promise<string>((resolve) => {
    // execFile avoids shell interpretation of the command — args are passed
    // directly to the userShell binary as argv, so quoting / metacharacters
    // in process.env.SHELL can't form a new command.
    childProcess.execFile(
      userShell,
      ['-ilc', 'printf "%s" "$PATH"'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          console.warn('[shellHelpers] failed to read user shell PATH:', err)
          resolvedShellPath = ''
          resolve('')
        } else {
          resolvedShellPath = stdout.trim()
          resolve(resolvedShellPath)
        }
      }
    )
  })
  return shellPathPromise
}

// ---------------------------------------------------------------------------
// App detection
// ---------------------------------------------------------------------------

export type DetectedApp = {
  /** App bundle name (e.g. "Cursor", "Visual Studio Code") — used in CLI invocations. */
  name: string
  /** Optional display label (defaults to name). */
  label?: string
  /** Filesystem path of the .app bundle (for existence checks). */
  appPath: string
}

type AppSpec = { name: string; label?: string }

const EDITOR_SPECS: AppSpec[] = [
  { name: 'Cursor' },
  { name: 'Visual Studio Code', label: 'VS Code' },
  { name: 'Zed' },
  { name: 'Sublime Text' },
  { name: 'RubyMine' },
  { name: 'WebStorm' },
  { name: 'Nova' },
  { name: 'GitHub Desktop' },
  { name: 'Xcode' },
  { name: 'IntelliJ IDEA' }
]

const TERMINAL_SPECS: AppSpec[] = [
  { name: 'Ghostty' },
  { name: 'iTerm' },
  { name: 'Warp' },
  { name: 'Terminal' },
  { name: 'Alacritty' },
  { name: 'Kitty' },
  { name: 'WezTerm' }
]

function probeApps(specs: AppSpec[]): DetectedApp[] {
  if (process.platform !== 'darwin') return []
  const found: DetectedApp[] = []
  for (const spec of specs) {
    try {
      const appPath = `/Applications/${spec.name}.app`
      if (fs.existsSync(appPath)) {
        found.push({ name: spec.name, ...(spec.label ? { label: spec.label } : {}), appPath })
      }
    } catch {
      // swallow per-item errors
    }
  }
  return found
}

export function listEditorApps(): DetectedApp[] {
  return probeApps(EDITOR_SPECS)
}

export function listTerminalApps(): DetectedApp[] {
  return probeApps(TERMINAL_SPECS)
}

function appExists(name: string): boolean {
  try {
    return fs.existsSync(`/Applications/${name}.app`)
  } catch {
    return false
  }
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    // showItemInFolder works on both files and directories and highlights the item
    shell.showItemInFolder(path)
  } catch (err) {
    console.warn('[shellHelpers] revealInFinder failed:', err)
  }
}

export async function openInEditor(path: string, preferredApp?: string): Promise<void> {
  try {
    // 0. Honor explicit preferred app (if it exists)
    if (preferredApp && appExists(preferredApp)) {
      childProcess
        .spawn('open', ['-a', preferredApp, path], { detached: true, stdio: 'ignore' })
        .unref()
      return
    }
    // 1. Honour EDITOR / VISUAL env vars
    const envEditor = process.env.EDITOR || process.env.VISUAL
    if (envEditor) {
      childProcess.spawn(envEditor, [path], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    // 2. Detect installed .app bundles in /Applications
    const editors = listEditorApps()
    for (const editor of editors) {
      childProcess
        .spawn('open', ['-a', editor.name, path], { detached: true, stdio: 'ignore' })
        .unref()
      return
    }
    // 3. OS default fallback
    await shell.openPath(path)
  } catch (err) {
    console.warn('[shellHelpers] openInEditor failed:', err)
  }
}

export async function openTerminal(path: string, preferredApp?: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      // 0. Honor explicit preferred app (if it exists)
      if (preferredApp && appExists(preferredApp)) {
        childProcess
          .spawn('open', ['-a', preferredApp, path], { detached: true, stdio: 'ignore' })
          .unref()
        return
      }
      // 1. Detect installed terminal apps
      const terminals = listTerminalApps()
      for (const term of terminals) {
        childProcess
          .spawn('open', ['-a', term.name, path], { detached: true, stdio: 'ignore' })
          .unref()
        return
      }
      // 2. Fallback: built-in Terminal
      childProcess
        .spawn('open', ['-a', 'Terminal', path], { detached: true, stdio: 'ignore' })
        .unref()
    } else {
      // Non-macOS: best-effort via shell.openPath
      await shell.openPath(path)
    }
  } catch (err) {
    console.warn('[shellHelpers] openTerminal failed:', err)
  }
}

export function copyToClipboard(text: string): void {
  try {
    clipboard.writeText(text)
  } catch (err) {
    console.warn('[shellHelpers] copyToClipboard failed:', err)
  }
}
