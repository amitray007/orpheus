import { useEffect, useState } from 'react'
import type React from 'react'
import { ArrowSquareOut } from '@phosphor-icons/react'

// ---------------------------------------------------------------------------
// OrpheusAboutSection — Orpheus version, paths, links
// ---------------------------------------------------------------------------

export function OrpheusAboutSection(): React.JSX.Element {
  const [orpheusVersion, setOrpheusVersion] = useState<string | null>(null)

  useEffect(() => {
    window.api.app.getVersion().then(setOrpheusVersion).catch(console.error)
  }, [])

  // Stable paths derived at render time — no IPC needed
  const dbPath = '~/Library/Application Support/Orpheus/orpheus.sqlite'
  const logPath = '~/Library/Logs/Orpheus/'
  const configDir = '~/.claude/'

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">About Orpheus</h2>
        <p className="text-xs text-text-muted mt-1">
          Version info, key file paths, and project links.
        </p>
      </div>

      {/* App identity */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Orpheus
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Orpheus is a closed-source Mac IDE built around Claude Code. It wraps Claude Code inside
            a persistent, workspace-aware terminal powered by{' '}
            <span className="font-mono text-xs bg-surface-overlay px-1 py-0.5 rounded">
              libghostty
            </span>{' '}
            and provides project management, session history, and a native macOS shell so Claude
            always runs in the right context.
          </p>
        </div>
      </section>

      {/* Version */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Version
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/40">
          <InfoRow label="Orpheus version" value={orpheusVersion ? `v${orpheusVersion}` : 'Loading…'} mono />
          <InfoRow label="Ghostty version" value="v1.3.1 (Lakr233/libghostty-spm prebuilt)" mono />
          <InfoRow label="Runtime" value="Tauri 2 + libghostty (embedded terminal)" />
        </div>
      </section>

      {/* Key paths */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Key paths
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/40">
          <InfoRow label="Database" value={dbPath} mono />
          <InfoRow label="Claude config" value={configDir} mono />
          <InfoRow label="Log files" value={logPath} mono />
        </div>
      </section>

      {/* Links */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Links
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/40">
          <ExternalLinkRow label="GitHub repository (private)" url="https://github.com/amitray007/orpheus" />
          <ExternalLinkRow label="Report a bug" url="https://github.com/amitray007/orpheus/issues/new" />
          <ExternalLinkRow label="libghostty-spm (Ghostty bindings)" url="https://github.com/Lakr233/libghostty-spm" />
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function InfoRow({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between px-5 py-3 gap-4">
      <span className="text-sm text-text-secondary flex-shrink-0">{label}</span>
      <span
        className={[
          'text-sm text-text-primary text-right break-all',
          mono ? 'font-mono text-xs' : ''
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  )
}

function ExternalLinkRow({ label, url }: { label: string; url: string }): React.JSX.Element {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between px-5 py-3 gap-4 hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 group"
    >
      <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
        {label}
      </span>
      <ArrowSquareOut size={14} className="text-text-muted flex-shrink-0" />
    </a>
  )
}
