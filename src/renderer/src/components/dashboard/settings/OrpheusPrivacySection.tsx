import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState, ProjectRecord } from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// OrpheusPrivacySection — global Privacy Mode toggle + per-project
// classified/hidden management. Privacy Mode itself is also driven by the
// View menu (Cmd+Shift+H); both write the same uiState.privacyMode field and
// stay in sync via uiState:changed.
// ---------------------------------------------------------------------------

export function OrpheusPrivacySection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.uiState.get(), window.api.projects.list()])
      .then(([s, p]) => {
        if (cancelled) return
        setUiState(s)
        setProjects(p)
      })
      .catch(console.error)

    // Stay in sync when privacy mode is flipped elsewhere (View menu, Cmd+Shift+H)
    const off = window.api.uiState.onChanged((s) => {
      if (!cancelled) setUiState(s)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  function patchPrivacyMode(v: boolean): void {
    if (!uiState) return
    setUiState({ ...uiState, privacyMode: v })
    window.api.uiState.update({ privacyMode: v }).catch(console.error)
  }

  function toggleClassified(id: string, v: boolean): void {
    window.api.projects
      .setClassified(id, v)
      .then((record) => {
        setProjects((prev) => prev?.map((p) => (p.id === id ? record : p)) ?? prev)
      })
      .catch(console.error)
  }

  function unhide(id: string): void {
    window.api.projects
      .setHidden(id, false)
      .then((record) => {
        setProjects((prev) => prev?.map((p) => (p.id === id ? record : p)) ?? prev)
      })
      .catch(console.error)
  }

  if (!uiState || !projects) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Privacy</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Keep classified projects off your screen when it matters.
          </p>
        </div>
        <SettingsSectionSkeleton groups={2} rowsPerGroup={2} />
      </div>
    )
  }

  const hiddenProjects = projects.filter((p) => p.hidden)

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Privacy</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Keep classified projects off your screen when it matters.
        </p>
      </div>

      {/* Privacy Mode toggle */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Privacy Mode</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Privacy Mode"
            description="Redact classified projects in the sidebar so they don't leak in screenshots."
          >
            <Toggle
              value={uiState.privacyMode}
              onChange={patchPrivacyMode}
              ariaLabel="Privacy Mode"
            />
          </SettingRow>
        </div>
      </section>

      {/* Classified projects */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Classified projects</Eyebrow>
        <p className="text-xs text-text-muted -mt-1.5 mb-3">
          Mark a project classified to redact it in the sidebar and Workspaces view while Privacy
          Mode is on.
        </p>
        {projects.length === 0 ? (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
            <p className="text-xs text-text-muted">No projects yet.</p>
          </div>
        ) : (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5">
            {projects.map((p) => (
              <SettingRow key={p.id} label={p.name}>
                <Toggle
                  value={p.classified}
                  onChange={(v) => toggleClassified(p.id, v)}
                  ariaLabel={`Classified — ${p.name}`}
                />
              </SettingRow>
            ))}
          </div>
        )}
      </section>

      {/* Hidden projects */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Hidden projects</Eyebrow>
        <p className="text-xs text-text-muted -mt-1.5 mb-3">
          Hidden from the sidebar and Workspaces view regardless of Privacy Mode. Hide a project
          from its sidebar context menu.
        </p>
        {hiddenProjects.length === 0 ? (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
            <p className="text-xs text-text-muted">No hidden projects.</p>
          </div>
        ) : (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5">
            {hiddenProjects.map((p) => (
              <SettingRow key={p.id} label={p.name}>
                <button
                  type="button"
                  onClick={() => unhide(p.id)}
                  className="px-3 py-1.5 rounded text-xs font-medium text-text-muted border border-border-default hover:text-text-primary hover:border-border-hover transition-colors cursor-pointer"
                >
                  Unhide
                </button>
              </SettingRow>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
