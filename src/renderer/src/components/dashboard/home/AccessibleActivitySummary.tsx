import type { WeeklyActivityDay } from '@shared/types'

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function pluralize(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`
}

export function AccessibleActivitySummary({
  days,
  providerLabel
}: {
  days: WeeklyActivityDay[]
  providerLabel: string
}): React.JSX.Element {
  const sessions = days.reduce((total, day) => total + day.sessions, 0)
  const messages = days.reduce((total, day) => total + day.messages, 0)

  return (
    <section className="flex flex-col gap-3" aria-labelledby="activity-data-summary-title">
      <div>
        <h2 id="activity-data-summary-title" className="text-sm font-semibold text-text-primary">
          Weekly data summary
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {providerLabel}: {pluralize(sessions, 'session')} and {pluralize(messages, 'message')}{' '}
          from Monday through Sunday.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border-default">
        <table className="w-full min-w-[360px] border-collapse text-left text-sm">
          <caption className="sr-only">{providerLabel} activity by weekday</caption>
          <thead className="bg-surface-overlay text-xs text-text-secondary">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Day
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Sessions
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Messages
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {days.map((day) => (
              <tr key={day.weekday} className="text-text-primary">
                <th scope="row" className="px-3 py-2 font-medium">
                  {WEEKDAY_NAMES[day.weekday] ?? `Day ${day.weekday + 1}`}
                </th>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{day.sessions}</td>
                <td className="px-3 py-2 text-right font-mono tabular-nums">{day.messages}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border-default bg-surface-overlay font-semibold text-text-primary">
            <tr>
              <th scope="row" className="px-3 py-2">
                Total
              </th>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{sessions}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{messages}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
