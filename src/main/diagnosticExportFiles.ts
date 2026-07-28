import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DiagRow } from '../shared/types'
import { sanitizeDiagnosticRowsForOutput } from './diagnosticOutputRedaction'
import { redactErrorMessage } from './logRedaction'

let temporarySequence = 0

function temporaryPath(finalPath: string): string {
  const parsed = path.parse(finalPath)
  return path.join(parsed.dir, `.${parsed.base}.orpheus-${process.pid}-${temporarySequence++}.tmp`)
}

function writePrivateFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.chmodSync(filePath, 0o600)
}

/**
 * Prepare both export files privately before replacing either destination.
 * On failure only Orpheus-owned temporary files are removed; existing user
 * files and diagnostic database rows are never purged as cleanup.
 */
export function writePrivateDiagnosticReportFiles(
  txtPath: string,
  jsonPath: string,
  txtContent: string,
  rows: readonly DiagRow[]
): { ok: true } | { ok: false; error: string } {
  const txtTemporary = temporaryPath(txtPath)
  const jsonTemporary = temporaryPath(jsonPath)
  try {
    writePrivateFile(txtTemporary, txtContent)
    writePrivateFile(jsonTemporary, JSON.stringify(sanitizeDiagnosticRowsForOutput(rows), null, 2))
    fs.renameSync(jsonTemporary, jsonPath)
    fs.renameSync(txtTemporary, txtPath)
    fs.chmodSync(jsonPath, 0o600)
    fs.chmodSync(txtPath, 0o600)
    return { ok: true }
  } catch (error) {
    for (const candidate of [txtTemporary, jsonTemporary]) {
      try {
        fs.unlinkSync(candidate)
      } catch {
        /* best-effort cleanup of Orpheus-owned temporary files only */
      }
    }
    return {
      ok: false,
      error: `Report could not be completed: ${redactErrorMessage(error)}`
    }
  }
}
