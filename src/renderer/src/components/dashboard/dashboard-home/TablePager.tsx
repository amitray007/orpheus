// ---------------------------------------------------------------------------
// TablePager — the shared compact pager footer for the three dashboard
// tables (Pr/Issues/LiveAgents), matching dashboard-v3.html's `.pager`
// block: right-aligned `[‹]  N of M  [›]`. ONE shared component (rather than
// copy-pasting the markup three times) so the pager UI stays visually
// consistent and doesn't trip no-duplicate-string/no-identical-functions.
//
// `page`/`pageCount` are both 1-INDEXED here (display-ready) — callers pass
// `page + 1` if they track a 0-indexed page internally. The caller owns all
// page-clamping logic; this component is presentation-only (prev/next
// button disabled state + the "N of M" label).
// ---------------------------------------------------------------------------

const PAGER_BUTTON_CLASS =
  'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border-default bg-surface-overlay text-[12px] text-text-secondary transition-colors hover:border-accent hover:text-text-primary disabled:cursor-default disabled:opacity-35 disabled:hover:border-border-default disabled:hover:text-text-secondary'

export function TablePager({
  page,
  pageCount,
  onPrev,
  onNext
}: {
  /** 1-indexed current page (display-ready). */
  page: number
  pageCount: number
  onPrev: () => void
  onNext: () => void
}): React.JSX.Element {
  return (
    <div className="mt-auto flex items-center justify-end gap-2 pt-3">
      <span className="font-mono text-[11px] text-text-muted tabular-nums">
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
    </div>
  )
}
