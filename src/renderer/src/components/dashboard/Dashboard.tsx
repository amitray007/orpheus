import { useEffect, useState } from 'react'
import { Topbar } from './Topbar'
import { Sidebar } from './Sidebar'
import { Footer } from './Footer'

interface PlaceholderSectionProps {
  title: string
}

function PlaceholderSection({ title }: PlaceholderSectionProps): React.JSX.Element {
  return (
    <section>
      <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-2">
        {title}
      </h2>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-sm text-text-muted text-center">
        (coming soon)
      </div>
    </section>
  )
}

interface DashboardProps {
  claudeInstalled: boolean
}

export function Dashboard({ claudeInstalled }: DashboardProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    window.api.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('0.0.0'))
  }, [])

  return (
    <div className="flex flex-col h-full">
      <Topbar onToggleSidebar={() => setSidebarCollapsed((v) => !v)} />

      <div className="flex flex-1 min-h-0">
        <Sidebar collapsed={sidebarCollapsed} />

        {/* Right column: main content + footer (footer stays out of the sidebar's column) */}
        <div className="flex flex-1 flex-col min-w-0">
          <main className="flex-1 overflow-y-auto px-8 py-6">
            <div className="flex flex-col gap-6">
              <PlaceholderSection title="Activity" />
              <PlaceholderSection title="Recent Projects" />
              <PlaceholderSection title="Recent Sessions" />
            </div>
          </main>

          <Footer version={version} connected={claudeInstalled} />
        </div>
      </div>
    </div>
  )
}
