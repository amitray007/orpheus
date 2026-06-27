import { memo } from 'react'
import type React from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { Select } from '../settings/primitives'
import { DATE_RANGE_OPTIONS, type DateRange } from './sessions-tab-helpers'

interface SessionsFilterBarProps {
  search: string
  onSearchChange: (value: string) => void
  dateRange: DateRange
  onDateRangeChange: (value: DateRange) => void
}

// Pure presentational toolbar — memo so stable-callback parents avoid unnecessary rerenders.
export const SessionsFilterBar = memo(function SessionsFilterBar({
  search,
  onSearchChange,
  dateRange,
  onDateRangeChange
}: SessionsFilterBarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex-1 min-w-0">
        <MagnifyingGlass
          size={12}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
        />
        <input
          type="text"
          aria-label="Search prompts"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search prompts"
          className="w-full pl-7 pr-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:border-accent/40 transition-colors"
        />
      </div>
      <div className="w-44 flex-shrink-0">
        <Select<DateRange>
          ariaLabel="Date range"
          options={DATE_RANGE_OPTIONS as ReadonlyArray<{ value: DateRange; label: string }>}
          value={dateRange}
          onChange={onDateRangeChange}
        />
      </div>
    </div>
  )
})
