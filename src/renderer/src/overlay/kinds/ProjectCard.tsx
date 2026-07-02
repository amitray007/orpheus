import type React from 'react'
import { GithubLogo, FolderOpen, Stack, PushPin } from '@phosphor-icons/react'
import type { ProjectCardProps } from '@shared/types'
import { ActivityIndicator } from '../../components/dashboard/ActivityIndicator'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// ProjectCard — collapsed-sidebar project hover popover (React migration of
// the chassis 'project' kind, addon.mm buildProjectCard). Same section order:
// header (name + pinned chip) / repo / path / workspace count / workspace
// list (up to 8 rows + "+K more" overflow) — using app design tokens instead
// of AppKit drawing. Width target ~224px to match the chassis card.
// ---------------------------------------------------------------------------

function SectionRow({
  icon,
  children
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-text-muted flex-shrink-0 inline-flex">{icon}</span>
      {children}
    </div>
  )
}

export function ProjectCard({ props }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as ProjectCardProps
  const { name, pinned, repo, path, workspaceCount, workspaces } = data

  const cap = 8
  const shown = workspaces.slice(0, cap)
  const overflow = workspaces.length > cap ? workspaces.length - cap : 0

  const countText =
    workspaceCount === 0
      ? 'No workspaces'
      : workspaceCount === 1
        ? '1 workspace'
        : `${workspaceCount} workspaces`

  return (
    <div className="w-max max-w-[224px] rounded-lg border border-border-default bg-surface-raised shadow-lg font-[family-name:var(--font-sans)] overflow-hidden">
      {/* Header */}
      <div className="px-2.5 py-2.5 flex items-center gap-2">
        <p className="text-xs font-medium text-text-primary truncate flex-1">{name || 'Project'}</p>
        {pinned && (
          <span className="inline-flex items-center gap-1 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-accent/10 border border-accent/30 text-accent">
            <PushPin size={10} weight="fill" />
            Pinned
          </span>
        )}
      </div>

      {repo && (
        <>
          <div className="h-px bg-border-default/60" />
          <div className="px-2.5 py-2.5">
            <SectionRow icon={<GithubLogo size={11} />}>
              <span className="text-text-secondary truncate">{repo}</span>
            </SectionRow>
          </div>
        </>
      )}

      <div className="h-px bg-border-default/60" />
      <div className="px-2.5 py-2.5">
        <div className="flex items-start gap-1.5 text-xs">
          <span className="text-text-muted flex-shrink-0 inline-flex mt-0.5">
            <FolderOpen size={11} />
          </span>
          <span className="text-text-muted break-all">{path || '-'}</span>
        </div>
      </div>

      <div className="h-px bg-border-default/60" />
      <div className="px-2.5 py-2.5">
        <SectionRow icon={<Stack size={11} />}>
          <span className="text-text-secondary truncate">{countText}</span>
        </SectionRow>
      </div>

      {shown.length > 0 && (
        <>
          <div className="h-px bg-border-default/60" />
          <div className="px-2.5 py-2.5 flex flex-col gap-1">
            {shown.map((ws, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <ActivityIndicator detail={ws.state} animated={false} />
                <span className="text-[11px] text-text-secondary truncate">
                  {ws.name || 'New workspace'}
                </span>
              </div>
            ))}
            {overflow > 0 && <p className="text-[10px] text-text-muted mt-0.5">+{overflow} more</p>}
          </div>
        </>
      )}
    </div>
  )
}
