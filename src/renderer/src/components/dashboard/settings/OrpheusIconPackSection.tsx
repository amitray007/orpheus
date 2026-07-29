import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Check } from '@phosphor-icons/react'
import type { IconPackCatalogResult } from '@shared/types'
import { SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { playSound } from '../../../lib/sound'

// ---------------------------------------------------------------------------
// OrpheusIconPackSection — Settings > General "App icon" picker.
//
// A responsive grid of pack cards, each showing that pack's actual preview
// image for the CURRENT build variant (main process resolves production vs.
// development vs. nightly vs. worktree->development — see
// src/main/iconPacks.ts's currentVariantKind). Preview images arrive as
// data: URIs over IPC (iconPacks:list/select) rather than a file:// path or a
// registered protocol, because the renderer runs sandboxed and cannot load
// arbitrary main-process filesystem paths directly — this mirrors the
// existing data-URI approach already used for Git-tab avatars
// (avatarCache.ts) and Files-tab image previews (files.ts's
// readImageContents), so there's no new loading mechanism to reason about.
//
// Keyboard model: the grid is a single `radiogroup` (arrow keys / Home / End
// move focus + selection together, mirroring a native macOS radio group and
// this file's SegmentedControl sibling in primitives.tsx); each card is a
// `radio` with roving tabIndex so Tab enters/exits the grid in one stop.
// Enter/Space also select (redundant with the native radio activation model,
// kept for explicitness since these are <button>s, not <input type=radio>).
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; catalog: IconPackCatalogResult }
  | { kind: 'error'; message: string }

export function OrpheusIconPackSection(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.iconPacks
      .list()
      .then((catalog) => {
        if (!cancelled) setState({ kind: 'ready', catalog })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function selectPack(id: string): Promise<void> {
    if (state.kind !== 'ready' || id === state.catalog.selectedId || pendingId) return
    setPendingId(id)
    playSound('tick')
    try {
      const catalog = await window.api.iconPacks.select(id)
      setState({ kind: 'ready', catalog })
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setPendingId(null)
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col gap-6 max-w-3xl">
        <div>
          <SectionTitle>App icon</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Choose which icon pack Orpheus uses for its Dock icon.
          </p>
        </div>
        <SettingsSectionSkeleton groups={1} rowsPerGroup={3} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <SectionTitle>App icon</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Choose which icon pack Orpheus uses for its Dock icon.
        </p>
      </div>

      {state.kind === 'error' && (
        <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-3 py-2">
          {state.message}
        </p>
      )}

      {state.kind === 'ready' && (
        <section className="flex flex-col gap-3">
          <Eyebrow>Icon pack</Eyebrow>
          <IconPackGrid
            catalog={state.catalog}
            pendingId={pendingId}
            onSelect={(id) => void selectPack(id)}
          />
          <p className="text-xs text-text-muted">
            The Dock icon updates immediately. The Finder/Applications icon is baked into the app
            bundle and only changes with Orpheus&apos;s next build or release.
          </p>
        </section>
      )}
    </div>
  )
}

interface IconPackGridProps {
  catalog: IconPackCatalogResult
  pendingId: string | null
  onSelect: (id: string) => void
}

function IconPackGrid({ catalog, pendingId, onSelect }: IconPackGridProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const { packs, selectedId } = catalog

  if (packs.length === 0) {
    return (
      <p className="text-xs text-text-muted italic">No icon packs are available in this build.</p>
    )
  }

  function focusCardAt(index: number): void {
    const el = containerRef.current?.querySelector<HTMLButtonElement>(
      `[data-pack-index="${index}"]`
    )
    el?.focus()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    const currentIndex = packs.findIndex(
      (p) => p.id === (document.activeElement as HTMLElement)?.dataset.packId
    )
    if (currentIndex < 0) return
    const count = packs.length
    // Grid is visually multi-column but logically a single sequence — Left/
    // Up move back, Right/Down move forward, matching a native macOS radio
    // group's linear traversal (columns re-flow at narrower widths, so a
    // strict 2D model would break on resize).
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault()
      focusCardAt((currentIndex + 1) % count)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusCardAt((currentIndex - 1 + count) % count)
    } else if (e.key === 'Home') {
      e.preventDefault()
      focusCardAt(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      focusCardAt(count - 1)
    }
  }

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label="Icon pack"
      onKeyDown={onKeyDown}
      className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3"
    >
      {packs.map((pack, index) => {
        const isSelected = pack.id === selectedId
        const isPending = pendingId === pack.id
        return (
          <button
            key={pack.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            data-pack-id={pack.id}
            data-pack-index={index}
            tabIndex={isSelected ? 0 : -1}
            disabled={pendingId !== null}
            onClick={() => onSelect(pack.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(pack.id)
              }
            }}
            title={pack.description}
            className={[
              'group flex flex-col gap-2 p-3 rounded-lg border text-left transition-colors cursor-pointer',
              'bg-surface-raised hover:border-border-hover',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
              isSelected ? 'border-accent/60' : 'border-border-default',
              isPending ? 'opacity-60 cursor-wait' : ''
            ].join(' ')}
          >
            <div className="relative aspect-square w-full rounded-md overflow-hidden bg-surface-overlay flex items-center justify-center">
              {pack.previewDataUri ? (
                <img
                  src={pack.previewDataUri}
                  alt={`${pack.name} icon preview`}
                  className="w-full h-full object-contain"
                  draggable={false}
                />
              ) : (
                <span className="text-xs text-text-muted">No preview</span>
              )}
              {isSelected && (
                <span className="absolute top-1.5 right-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-accent text-black">
                  <Check size={11} weight="bold" />
                </span>
              )}
            </div>
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-xs font-medium text-text-primary truncate">{pack.name}</span>
              <span className="text-xs text-text-muted line-clamp-2">{pack.description}</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
