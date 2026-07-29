import { useEffect, useState } from 'react'
import type React from 'react'
import type { ProdImportPreflight, ProdImportResult } from '@shared/types'
import { SectionTitle } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { ConfirmModal } from '../../ConfirmModal'

// ---------------------------------------------------------------------------
// OrpheusProdImportSection — nightly-only. Lets a nightly build pull a
// read-only snapshot of the user's PRODUCTION Orpheus data (projects,
// workspaces, sessions, settings) into nightly's own DB, so nightly testing
// exercises real data instead of an empty install.
//
// Strictly one-way: production is only ever read (VACUUM INTO against a
// readonly handle — see src/main/db/importProdData.ts); nothing is ever
// written back to it. This section only renders in nightly builds
// (__ORPHEUS_MODE__ === 'nightly'; see SettingsView.tsx's GROUPS filter),
// mirroring how OrpheusUpdatesSection.tsx's dev-only debug seam is gated the
// other direction.
// ---------------------------------------------------------------------------

type ImportState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }

function errorCopy(result: Extract<ProdImportResult, { ok: false }>): string {
  switch (result.error) {
    case 'not_nightly':
      return 'This build is not a nightly build — import is unavailable.'
    case 'not_found':
      return 'No production database was found.'
    case 'schema_newer':
      return 'Production data was migrated by a newer version of Orpheus than this nightly build. Update nightly first, then try again.'
    case 'snapshot_failed':
      return `Could not read production data${result.message ? `: ${result.message}` : '.'}`
    case 'backup_failed':
      return `Could not back up nightly's current data — import was cancelled, nothing changed${result.message ? `: ${result.message}` : '.'}`
    case 'swap_failed':
      return `The backup succeeded but swapping in the new data failed${result.message ? `: ${result.message}` : '.'} Nightly's prior data is safe in the backup file.`
    default:
      return 'Import failed.'
  }
}

export function OrpheusProdImportSection(): React.JSX.Element {
  const [preflight, setPreflight] = useState<ProdImportPreflight | null>(null)
  const [state, setState] = useState<ImportState>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    window.api.prodImport
      .preflight()
      .then((result) => {
        if (!cancelled) setPreflight(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleConfirm(): Promise<void> {
    setState({ kind: 'running' })
    try {
      const result = await window.api.prodImport.run()
      // A successful import relaunches the app before this promise can ever
      // resolve with ok:true — reaching an ok:false here is the only real
      // outcome to handle.
      if (!result.ok) {
        setState({ kind: 'error', message: errorCopy(result) })
      }
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  if (preflight === null && state.kind !== 'error') {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Import production data</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Copy your real Orpheus data into this nightly build for testing.
          </p>
        </div>
        <SettingsSectionSkeleton groups={1} rowsPerGroup={2} />
      </div>
    )
  }

  const disabled =
    state.kind === 'running' || !preflight?.prodFound || preflight.schemaNewer === true

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Import production data</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Copy your real Orpheus data into this nightly build so testing exercises actual projects
          and workspaces instead of an empty install.
        </p>
      </div>

      <section className="flex flex-col">
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4 flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium text-text-primary">Source</p>
            <code className="text-xs font-mono text-text-muted break-all">
              {preflight?.prodDbPath ?? '—'}
            </code>
          </div>

          <StatusLine preflight={preflight} />

          <ul className="text-xs text-text-muted list-disc pl-4 flex flex-col gap-1">
            <li>Production is only ever read — nothing is written back to it.</li>
            <li>Nightly&apos;s current data is backed up before it&apos;s replaced.</li>
            <li>Orpheus relaunches automatically once the import finishes.</li>
          </ul>

          {state.kind === 'error' && (
            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-3 py-2">
              {state.message}
            </p>
          )}

          <div>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setState({ kind: 'confirming' })}
              className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-black hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {state.kind === 'running' ? 'Importing…' : 'Import from production'}
            </button>
          </div>
        </div>
      </section>

      {state.kind === 'confirming' && (
        <ConfirmModal
          title="Import production data into nightly?"
          body={
            <div className="flex flex-col gap-2">
              <p>
                This replaces nightly&apos;s current data with a copy of your production Orpheus
                data. Nightly&apos;s current data is backed up first, and production is left
                completely untouched.
              </p>
              <p>Orpheus will relaunch automatically once the import finishes.</p>
            </div>
          }
          confirmLabel="Import and relaunch"
          destructive
          onConfirm={handleConfirm}
          onCancel={() => setState({ kind: 'idle' })}
        />
      )}
    </div>
  )
}

function StatusLine({
  preflight
}: {
  preflight: ProdImportPreflight | null
}): React.JSX.Element | null {
  if (!preflight) return null
  if (!preflight.prodFound) {
    return (
      <p className="text-xs text-text-muted">
        No production database found at this path — nothing to import.
      </p>
    )
  }
  if (preflight.schemaNewer) {
    return (
      <p className="text-xs text-red-400">
        Production data looks newer than this nightly build supports. Update nightly before
        importing.
      </p>
    )
  }
  return <p className="text-xs text-text-muted">Production data found and ready to import.</p>
}
