import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { Select } from '../settings/primitives'

export function GithubCardFilters<T extends string>({
  query,
  searchLabel,
  placeholder,
  onQueryChange,
  filter,
  defaultFilter,
  filterLabel,
  filterOptions,
  onFilterChange,
  onReset
}: {
  query: string
  searchLabel: string
  placeholder: string
  onQueryChange: (value: string) => void
  filter?: T
  defaultFilter?: T
  filterLabel?: string
  filterOptions?: ReadonlyArray<{ value: T; label: string }>
  onFilterChange?: (value: T) => void
  onReset: () => void
}): React.JSX.Element {
  const hasActiveFilter =
    query.trim().length > 0 ||
    (filter !== undefined && defaultFilter !== undefined && filter !== defaultFilter)
  const showSelect =
    filter !== undefined &&
    filterLabel !== undefined &&
    filterOptions !== undefined &&
    onFilterChange !== undefined

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-2 border-b border-border-default pb-2">
      <div className="relative min-w-[150px] flex-1">
        <MagnifyingGlass
          size={13}
          weight="bold"
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label={searchLabel}
          placeholder={placeholder}
          className="h-8 w-full rounded-md border border-border-default bg-surface-overlay pr-8 pl-8 text-xs text-text-primary outline-none placeholder:text-text-muted focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/40 [&::-webkit-search-cancel-button]:hidden"
        />
        <button
          type="button"
          onClick={onReset}
          aria-label={`Reset ${searchLabel.toLowerCase()}${showSelect ? ' and filters' : ''}`}
          tabIndex={hasActiveFilter ? 0 : -1}
          className={[
            'absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-text-muted outline-none hover:bg-surface-raised hover:text-text-primary focus-visible:ring-1 focus-visible:ring-accent/50',
            hasActiveFilter ? 'visible' : 'invisible pointer-events-none'
          ].join(' ')}
        >
          <X size={12} weight="bold" aria-hidden="true" />
        </button>
      </div>

      {showSelect ? (
        <div className="w-32 shrink-0">
          <Select<T>
            ariaLabel={filterLabel}
            options={filterOptions}
            value={filter}
            onChange={onFilterChange}
            className="[&>button]:h-8"
          />
        </div>
      ) : null}
    </div>
  )
}

export function GithubFilteredEmptyState(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
    >
      <div className="text-sm font-medium text-text-primary">No matches</div>
      <div className="text-xs text-text-muted">Try changing the search or filter.</div>
    </div>
  )
}
