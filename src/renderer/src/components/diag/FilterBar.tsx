import type React from 'react'
import { MagnifyingGlass, Pause, Play, Trash } from '@phosphor-icons/react'
import type { DiagCategory, DiagLevel } from '@shared/types'

const CATEGORIES: DiagCategory[] = ['error', 'lifecycle', 'perf', 'anomaly', 'trace']
const LEVELS: DiagLevel[] = ['debug', 'info', 'warn', 'error', 'fatal']

export interface FilterState {
  categories: Set<DiagCategory>
  minLevel: DiagLevel
  search: string
}

interface FilterBarProps {
  filters: FilterState
  paused: boolean
  onToggleCategory: (cat: DiagCategory) => void
  onSetMinLevel: (level: DiagLevel) => void
  onSetSearch: (s: string) => void
  onTogglePause: () => void
  onClear: () => void
}

export function FilterBar({
  filters,
  paused,
  onToggleCategory,
  onSetMinLevel,
  onSetSearch,
  onTogglePause,
  onClear
}: FilterBarProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border-default bg-surface-raised">
      {/* Category toggles */}
      <div className="flex items-center gap-1">
        {CATEGORIES.map((cat) => {
          const active = filters.categories.has(cat)
          return (
            <button
              type="button"
              key={cat}
              onClick={() => onToggleCategory(cat)}
              className={[
                'px-2 py-0.5 rounded text-[11px] font-mono border transition-colors',
                active
                  ? 'bg-accent/15 text-accent border-accent/30'
                  : 'bg-transparent text-text-muted border-border-default hover:border-border-hover hover:text-text-secondary'
              ].join(' ')}
            >
              {cat}
            </button>
          )
        })}
      </div>

      <div className="w-px h-4 bg-border-default" />

      {/* Level threshold */}
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-text-muted font-mono">≥</span>
        <select
          value={filters.minLevel}
          onChange={(e) => onSetMinLevel(e.target.value as DiagLevel)}
          className="bg-surface-overlay border border-border-default rounded text-[11px] font-mono text-text-secondary px-1.5 py-0.5 focus:outline-none focus:border-border-hover"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <div className="w-px h-4 bg-border-default" />

      {/* Search */}
      <div className="flex items-center gap-1 flex-1 min-w-[140px]">
        <MagnifyingGlass size={12} className="text-text-muted shrink-0" />
        <input
          type="text"
          aria-label="Search"
          value={filters.search}
          onChange={(e) => onSetSearch(e.target.value)}
          placeholder="search…"
          className="flex-1 bg-transparent text-[11px] font-mono text-text-secondary placeholder:text-text-muted focus:outline-none"
        />
      </div>

      {/* Pause / Clear */}
      <div className="flex items-center gap-1 ml-auto">
        <button
          type="button"
          onClick={onTogglePause}
          className={[
            'flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono transition-colors',
            paused
              ? 'bg-accent/15 text-accent border-accent/30'
              : 'bg-transparent text-text-muted border-border-default hover:border-border-hover hover:text-text-secondary'
          ].join(' ')}
        >
          {paused ? <Play size={11} weight="fill" /> : <Pause size={11} weight="fill" />}
          {paused ? 'resume' : 'pause'}
        </button>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-border-default text-[11px] font-mono text-text-muted hover:border-border-hover hover:text-text-secondary transition-colors"
        >
          <Trash size={11} />
          clear
        </button>
      </div>
    </div>
  )
}
