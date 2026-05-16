import type React from 'react'
import { CaretUp, CaretDown, CaretLeft, CaretRight } from '@phosphor-icons/react'
import { Skeleton } from './Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataTableColumn<R> {
  /** Unique identifier; used as the sort field emitted unless sortField overrides. */
  key: string
  /** Override the field name emitted to onSortChange. */
  sortField?: string
  label: string
  sortable?: boolean
  /** CSS width string (e.g. '120px'). Absent = column flexes. */
  width?: string
  align?: 'left' | 'right' | 'center'
  /** Custom cell renderer. Falls back to String(row[key as keyof R]). */
  render?: (row: R) => React.ReactNode
  /** Drop cell padding so icon-only buttons fit. Default true. */
  cellPadded?: boolean
}

export interface DataTablePagination {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

export interface DataTableProps<R> {
  columns: DataTableColumn<R>[]
  rows: R[]
  rowKey: (row: R) => string
  loading?: boolean
  emptyState?: React.ReactNode
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  onSortChange?: (by: string, dir: 'asc' | 'desc') => void
  pagination?: DataTablePagination
  onRowClick?: (row: R) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGridTemplateColumns<R>(columns: DataTableColumn<R>[]): string {
  return columns.map((c) => c.width ?? '1fr').join(' ')
}

function defaultCellValue<R>(row: R, key: string): string {
  const val = (row as Record<string, unknown>)[key]
  return val === null || val === undefined ? '' : String(val)
}

function alignClass(align?: 'left' | 'right' | 'center'): string {
  if (align === 'right') return 'justify-end text-right'
  if (align === 'center') return 'justify-center text-center'
  return 'justify-start text-left'
}

// ---------------------------------------------------------------------------
// Skeleton rows
// ---------------------------------------------------------------------------

function SkeletonRows<R>({
  columns,
  count
}: {
  columns: DataTableColumn<R>[]
  count: number
}): React.JSX.Element {
  const gridTemplate = getGridTemplateColumns(columns)
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          role="row"
          aria-hidden="true"
          style={{ gridTemplateColumns: gridTemplate }}
          className="grid border-b border-border-default/40 last:border-b-0"
        >
          {columns.map((col) => (
            <div key={col.key} className="flex items-center py-2.5 px-3">
              <Skeleton className={['h-3.5', col.width ? 'w-full' : 'w-3/4'].join(' ')} />
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Pagination footer
// ---------------------------------------------------------------------------

interface PaginationProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

function PaginationFooter({
  page,
  pageSize,
  total,
  onPageChange
}: PaginationProps): React.JSX.Element {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = Math.min((page - 1) * pageSize + 1, total)
  const end = Math.min(page * pageSize, total)
  const hasPrev = page > 1
  const hasNext = page < totalPages

  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-t border-border-default/60">
      <span className="text-xs text-text-muted tabular-nums">
        Showing {start}–{end} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={!hasPrev}
          aria-label="Previous page"
          className={[
            'inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
            hasPrev
              ? 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay cursor-pointer'
              : 'opacity-40 cursor-not-allowed text-text-muted'
          ].join(' ')}
        >
          <CaretLeft size={13} weight="bold" />
        </button>
        <span className="text-xs text-text-muted tabular-nums" aria-live="polite">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNext}
          aria-label="Next page"
          className={[
            'inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
            hasNext
              ? 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay cursor-pointer'
              : 'opacity-40 cursor-not-allowed text-text-muted'
          ].join(' ')}
        >
          <CaretRight size={13} weight="bold" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

export function DataTable<R>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyState,
  sortBy,
  sortDir = 'desc',
  onSortChange,
  pagination,
  onRowClick
}: DataTableProps<R>): React.JSX.Element {
  const gridTemplate = getGridTemplateColumns(columns)
  const skeletonCount = pagination ? Math.min(pagination.pageSize, 8) : 8

  function handleSortClick(col: DataTableColumn<R>): void {
    if (!col.sortable || !onSortChange) return
    const field = col.sortField ?? col.key
    if (field === sortBy) {
      // Same column — toggle direction
      onSortChange(field, sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      // New column — default to desc (recent-first)
      onSortChange(field, 'desc')
    }
  }

  return (
    <div className="rounded-lg border border-border-default bg-surface-raised overflow-hidden">
      {/* Table wrapper with sticky header support */}
      <div className="overflow-auto">
        {/* Header */}
        <div
          role="row"
          style={{ gridTemplateColumns: gridTemplate }}
          className="grid sticky top-0 z-10 bg-surface-overlay/40 border-b border-border-default/60"
        >
          {columns.map((col) => {
            const field = col.sortField ?? col.key
            const isActive = sortBy === field
            return (
              <div
                key={col.key}
                role="columnheader"
                aria-sort={
                  isActive
                    ? sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : col.sortable
                      ? 'none'
                      : undefined
                }
                onClick={() => handleSortClick(col)}
                className={[
                  'flex items-center gap-1 py-2 px-3',
                  'text-xs uppercase tracking-wider font-medium',
                  'transition-colors duration-100 select-none',
                  alignClass(col.align),
                  col.sortable
                    ? 'cursor-pointer ' +
                      (isActive ? 'text-text-primary' : 'text-text-muted hover:text-text-primary')
                    : 'text-text-muted'
                ].join(' ')}
              >
                <span>{col.label}</span>
                {col.sortable &&
                  isActive &&
                  (sortDir === 'asc' ? (
                    <CaretUp size={11} weight="bold" className="flex-shrink-0" />
                  ) : (
                    <CaretDown size={11} weight="bold" className="flex-shrink-0" />
                  ))}
              </div>
            )
          })}
        </div>

        {/* Body — always reserves pageSize rows of height to prevent CLS.
            Each row is py-2.5 + text-sm line height + border ≈ 41px. */}
        {(() => {
          const ROW_HEIGHT_PX = 41
          const reservedRows = pagination?.pageSize ?? skeletonCount
          const minBodyHeight = reservedRows * ROW_HEIGHT_PX

          if (loading) {
            return (
              <div role="rowgroup" style={{ minHeight: minBodyHeight }}>
                <SkeletonRows columns={columns} count={skeletonCount} />
              </div>
            )
          }

          if (rows.length === 0) {
            return (
              <div
                role="rowgroup"
                style={{ minHeight: minBodyHeight }}
                className="flex items-center justify-center px-4"
              >
                {emptyState ?? <span className="text-sm text-text-muted">No data</span>}
              </div>
            )
          }

          return (
            <div role="rowgroup" style={{ minHeight: minBodyHeight }}>
              {rows.map((row) => (
                <div
                  key={rowKey(row)}
                  role="row"
                  onClick={() => onRowClick?.(row)}
                  style={{ gridTemplateColumns: gridTemplate }}
                  className={[
                    'grid border-b border-border-default/40 last:border-b-0',
                    'transition-colors duration-100',
                    onRowClick ? 'cursor-pointer hover:bg-surface-overlay/50' : ''
                  ].join(' ')}
                >
                  {columns.map((col) => (
                    <div
                      key={col.key}
                      role="cell"
                      className={[
                        'flex items-center min-w-0',
                        col.cellPadded === false ? 'py-1 px-1.5' : 'py-2.5 px-3',
                        'text-sm text-text-primary',
                        alignClass(col.align)
                      ].join(' ')}
                    >
                      {col.render
                        ? col.render(row)
                        : <span className="truncate min-w-0">{defaultCellValue(row, col.key)}</span>}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )
        })()}
      </div>

      {/* Pagination */}
      {pagination && (
        <PaginationFooter
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          onPageChange={pagination.onPageChange}
        />
      )}
    </div>
  )
}
