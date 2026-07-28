import { ArrowClockwise } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function SourceRefreshButton({
  label = 'Refresh',
  refreshing = false,
  disabled = false,
  onRefresh
}: {
  label?: string
  refreshing?: boolean
  disabled?: boolean
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={disabled || refreshing}
      aria-busy={refreshing}
      onClick={onRefresh}
      className="bg-surface-raised text-text-secondary hover:border-accent hover:bg-surface-overlay hover:text-text-primary active:scale-[0.97]"
    >
      <ArrowClockwise
        weight="bold"
        aria-hidden="true"
        className={cn(refreshing && 'animate-spin')}
      />
      {refreshing ? 'Refreshing…' : label}
    </Button>
  )
}
