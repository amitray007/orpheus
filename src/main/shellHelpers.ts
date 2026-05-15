import { shell, clipboard } from 'electron'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'

// Ordered list of editors to detect in /Applications (prefer first found)
const EDITOR_APPS = ['Cursor.app', 'Visual Studio Code.app', 'Zed.app']

// Ordered list of terminals to detect in /Applications (prefer first found)
const TERMINAL_APPS = ['Ghostty.app', 'iTerm.app', 'Warp.app']

function appExists(name: string): boolean {
  return fs.existsSync(`/Applications/${name}`)
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    // showItemInFolder works on both files and directories and highlights the item
    shell.showItemInFolder(path)
  } catch (err) {
    console.warn('[shellHelpers] revealInFinder failed:', err)
  }
}

export async function openInEditor(path: string): Promise<void> {
  try {
    // 1. Honour EDITOR / VISUAL env vars
    const envEditor = process.env.EDITOR || process.env.VISUAL
    if (envEditor) {
      childProcess.spawn(envEditor, [path], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    // 2. Detect installed .app bundles in /Applications
    for (const app of EDITOR_APPS) {
      if (appExists(app)) {
        const appName = app.replace(/\.app$/, '')
        childProcess
          .spawn('open', ['-a', appName, path], { detached: true, stdio: 'ignore' })
          .unref()
        return
      }
    }
    // 3. OS default fallback
    await shell.openPath(path)
  } catch (err) {
    console.warn('[shellHelpers] openInEditor failed:', err)
  }
}

export async function openTerminal(path: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      // Prefer detected terminal apps over the system Terminal
      for (const app of TERMINAL_APPS) {
        if (appExists(app)) {
          const appName = app.replace(/\.app$/, '')
          childProcess
            .spawn('open', ['-a', appName, path], { detached: true, stdio: 'ignore' })
            .unref()
          return
        }
      }
      // Fallback: built-in Terminal
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
