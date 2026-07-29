// ---------------------------------------------------------------------------
// src/main/ipc/prodImport.ts
//
// IPC for the nightly-only "import data from production Orpheus" setting.
// Strictly one-way (production → nightly, never the reverse) — see
// src/main/db/importProdData.ts for the full implementation + rationale.
//
// isNightly is re-checked HERE, first thing in each handler, before any
// filesystem work — this is the primary refusal path for non-nightly
// builds; the renderer-side UI gating is defense-in-depth, not the
// authority. importProdData.ts's own assertNightly() is a second,
// throw-based guard purely against a future caller bug within main.
// ---------------------------------------------------------------------------

import { isNightly } from '../appMode'
import { preflightProdImport, runProdImport } from '../db/importProdData'
import type { ProdImportPreflight, ProdImportResult } from '../../shared/types'
import { handle } from './handle'

export function registerProdImportIpc(): void {
  handle('prodImport:preflight', (): ProdImportPreflight => {
    if (!isNightly) {
      return { prodDbPath: '', prodFound: false, schemaNewer: false }
    }
    return preflightProdImport()
  })

  handle('prodImport:run', (): ProdImportResult => {
    if (!isNightly) {
      return { ok: false, error: 'not_nightly' }
    }
    return runProdImport()
  })
}
