const PAGER_BUTTON_CLASS =
  'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border-default bg-surface-overlay text-[12px] text-text-secondary transition-colors hover:border-accent hover:text-text-primary disabled:cursor-default disabled:opacity-35 disabled:hover:border-border-default disabled:hover:text-text-secondary'

export interface TablePagerProps {
  /** 1-indexed current page (display-ready). */
  page: number
  pageCount: number
  onPrev: () => void
  onNext: () => void
}

/** Presentation-only pager; row tables own page bounds and state. */
export function TablePager({ page, pageCount, onPrev, onNext }: TablePagerProps): React.JSX.Element {
  return (
    <nav className="mt-auto flex items-center justify-end gap-2 pt-3" aria-label="Table pagination">
      <span className="font-mono text-[11px] text-text-muted tabular-nums" aria-live="polite">
        <b className="font-semibold text-text-primary">{page}</b> of {pageCount}
      </span>
      <button
        type="button"
        aria-label="Previous page"
        className={PAGER_BUTTON_CLASS}
        disabled={page <= 1}
        onClick={onPrev}
      >
        ‹
      </button>
      <button
        type="button"
        aria-label="Next page"
        className={PAGER_BUTTON_CLASS}
        disabled={page >= pageCount}
        onClick={onNext}
      >
        ›
      </button>
    </nav>
  )
}
