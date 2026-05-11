import { useEffect, useState } from 'react'
import { Topbar } from './Topbar'
import { Sidebar, type SidebarActiveView } from './Sidebar'
import { Footer } from './Footer'
import type { ProjectRecord } from '@shared/types'

// ---------------------------------------------------------------------------
// Placeholder (dashboard home — will be replaced in a later chunk)
// ---------------------------------------------------------------------------

function PlaceholderSection({ title }: { title: string }): React.JSX.Element {
  return (
    <section>
      <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-2">
        {title}
      </h2>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-sm text-text-muted text-center">
        Coming soon
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// View discriminant union
// ---------------------------------------------------------------------------

type View =
  | { kind: 'dashboard' }
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' }

// ---------------------------------------------------------------------------
// Main content area (stub for commit 1 — real views wired in commits 2+)
// ---------------------------------------------------------------------------

function MainContent({ view }: { view: View }): React.JSX.Element {
  if (view.kind === 'dashboard') {
    return (
      <div className="flex flex-col gap-6">
        <PlaceholderSection title="Activity" />
        <PlaceholderSection title="Recent Projects" />
        <PlaceholderSection title="Recent Sessions" />
      </div>
    )
  }

  if (view.kind === 'project') {
    return (
      <div className="flex flex-col gap-6">
        <PlaceholderSection title="Project" />
      </div>
    )
  }

  // sessions
  return (
    <div className="flex flex-col gap-6">
      <PlaceholderSection title="Sessions" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard shell
// ---------------------------------------------------------------------------

interface DashboardProps {
  claudeInstalled: boolean
}

export function Dashboard({ claudeInstalled }: DashboardProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [version, setVersion] = useState<string>('')

  // Projects state
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [addingProject, setAddingProject] = useState(false)

  // View routing
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  useEffect(() => {
    window.api.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('0.0.0'))
  }, [])

  useEffect(() => {
    window.api.projects
      .list()
      .then((list) => {
        setProjects(list)
        setProjectsLoading(false)
      })
      .catch((err) => {
        console.error('[dashboard] failed to load projects', err)
        setProjectsLoading(false)
      })
  }, [])

  function handleSelectProject(id: string): void {
    setSelectedProjectId(id)
    setView({ kind: 'project', projectId: id })
    // fire-and-forget: update last_opened_at
    window.api.projects.open(id).catch(console.error)
  }

  function handleSelectNav(nav: 'dashboard' | 'sessions'): void {
    setView({ kind: nav })
    setSelectedProjectId(null)
  }

  async function handleAddProject(): Promise<void> {
    setAddingProject(true)
    try {
      const result = await window.api.projects.pickAndAdd()
      if (result) {
        setProjects((arr) => [result, ...arr.filter((p) => p.id !== result.id)])
        setSelectedProjectId(result.id)
        setView({ kind: 'project', projectId: result.id })
      }
    } catch (err) {
      console.error('[dashboard] pickAndAdd failed', err)
    } finally {
      setAddingProject(false)
    }
  }

  const activeView: SidebarActiveView =
    view.kind === 'project' ? 'project' : view.kind === 'sessions' ? 'sessions' : 'dashboard'

  return (
    <div className="flex flex-col h-full">
      <Topbar onToggleSidebar={() => setSidebarCollapsed((v) => !v)} />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          collapsed={sidebarCollapsed}
          projects={projects}
          projectsLoading={projectsLoading}
          selectedProjectId={selectedProjectId}
          activeView={activeView}
          onSelectProject={handleSelectProject}
          onSelectNav={handleSelectNav}
          onAddProject={handleAddProject}
          addingProject={addingProject}
        />

        {/* Right column: main content + footer */}
        <div className="flex flex-1 flex-col min-w-0">
          <main className="flex-1 overflow-y-auto px-8 py-6">
            <MainContent view={view} />
          </main>

          <Footer version={version} connected={claudeInstalled} />
        </div>
      </div>
    </div>
  )
}
