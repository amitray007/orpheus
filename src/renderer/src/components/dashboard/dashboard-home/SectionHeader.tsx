// ---------------------------------------------------------------------------
// SectionHeader — the small mono-caps label + colored dot badge that titles
// each Dashboard section ("Your pulse", "Needs you now"), matching the
// mockup's `.sechead .t .badge` treatment. The dot color is passed in so
// each section can carry its own accent (violet for pulse, accent-gold for
// triage) while staying token-driven — no hardcoded hex anywhere.
// ---------------------------------------------------------------------------

import { cn } from '@/lib/utils'

export function SectionHeader({
  label,
  dotClassName
}: {
  label: string
  dotClassName: string
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.12em] uppercase text-text-muted">
        <span className={cn('h-[7px] w-[7px] rounded-[2px]', dotClassName)} aria-hidden="true" />
        {label}
      </span>
    </div>
  )
}
