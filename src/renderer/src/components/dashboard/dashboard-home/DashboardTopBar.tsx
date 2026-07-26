import { ArrowSquareOut, GithubLogo } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { greetingWithName } from './dashboardHome.helpers'

export function DashboardTopBar({
  login,
  name,
  loading = false,
  onViewProfile
}: {
  login: string | null
  name?: string | null
  loading?: boolean
  onViewProfile?: () => void
}): React.JSX.Element {
  const identity = login ? `@${login.replace(/^@/, '')}` : 'GitHub Not Connected'
  const greeting = greetingWithName(new Date().getHours(), name || login)

  return (
    <header className="flex min-h-14 flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-text-primary">
          {greeting}
        </h1>
        <div className="mt-1 flex min-h-5 items-center gap-1.5 text-sm text-text-muted">
          <GithubLogo size={14} weight="fill" aria-hidden="true" />
          {loading && !login ? (
            <span className="h-3 w-28 animate-pulse rounded bg-surface-overlay" />
          ) : (
            <span className="font-mono text-text-secondary">{identity}</span>
          )}
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onViewProfile}
        disabled={!onViewProfile}
        className="bg-surface-raised text-text-secondary hover:border-accent hover:bg-surface-overlay hover:text-text-primary active:scale-[0.97]"
      >
        View Profile
        <ArrowSquareOut weight="bold" aria-hidden="true" />
      </Button>
    </header>
  )
}
