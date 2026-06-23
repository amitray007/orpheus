import * as path from 'node:path'
import * as fs from 'node:fs'
import { app } from 'electron'

/**
 * Read the system ghostty config file and parse it into a flat key-value map.
 * Returns {} if the file doesn't exist or any error occurs (non-fatal).
 *
 * Config location: ~/Library/Application Support/com.mitchellh.ghostty/config
 */
export function readSystemGhosttyConfig(): Record<string, string | number | boolean> {
  try {
    const home = app.getPath('home')
    const configPath = path.join(
      home,
      'Library',
      'Application Support',
      'com.mitchellh.ghostty',
      'config'
    )
    if (!fs.existsSync(configPath)) return {}

    const content = fs.readFileSync(configPath, 'utf8')
    const result: Record<string, string | number | boolean> = {}

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      // Skip blank lines and comments
      if (!line || line.startsWith('#')) continue

      // Split on FIRST '=' only
      const eqIdx = line.indexOf('=')
      if (eqIdx === -1) continue

      const key = line.slice(0, eqIdx).trim()
      if (!key) continue

      let value: string = line.slice(eqIdx + 1).trim()

      // Strip surrounding double-quotes
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1)
      }

      // Coerce font-size to number if numeric
      if (key === 'font-size') {
        const n = Number(value)
        if (!isNaN(n)) {
          result[key] = n
          continue
        }
      }

      result[key] = value
    }

    return result
  } catch {
    return {}
  }
}
