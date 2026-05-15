import { useEffect, useState } from 'react'
import type React from 'react'
import { ArrowSquareOut } from '@phosphor-icons/react'
import { Skeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// ClaudeAboutSection — claude binary info, paths, docs links
// ---------------------------------------------------------------------------

export function ClaudeAboutSection(): React.JSX.Element {
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null)
  const [claudePath, setClaudePath] = useState<string | null>(null)

  useEffect(() => {
    // Doctor IPC already runs `claude --version` and `which claude`; reuse it.
    window.api.doctor.check().then((result) => {
      setClaudeVersion(result.claudeVersion)
      setClaudePath(result.claudePath)
    }).catch(console.error)
  }, [])

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">About Claude</h2>
        <p className="text-xs text-text-muted mt-1">
          Claude Code version, binary path, and links to documentation.
        </p>
      </div>

      {/* Claude Code info */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Claude Code
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/40">
          <InfoRow label="Version" value={claudeVersion} mono pendingWidth="6rem" />
          <InfoRow label="Binary path" value={claudePath} mono pendingWidth="18rem" />
          <InfoRow
            label="Runtime"
            value="Running via bundled libghostty terminal (Lakr233/libghostty-spm)"
          />
          <InfoRow label="Ghostty version" value="v1.3.1 (libghostty-spm prebuilt)" mono />
        </div>
      </section>

      {/* Documentation links */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Documentation
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/40">
          <ExternalLinkRow
            label="Claude Code docs"
            url="https://code.claude.com/docs"
          />
          <ExternalLinkRow
            label="Claude Code changelog"
            url="https://code.claude.com/docs/changelog"
          />
          <ExternalLinkRow
            label="Anthropic API reference"
            url="https://docs.anthropic.com/en/api/getting-started"
          />
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
  mono,
  pendingWidth
}: {
  label: string
  value: string | null
  mono?: boolean
  pendingWidth?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-5 py-3 gap-4">
      <span className="text-sm text-text-secondary">{label}</span>
      {value === null ? (
        <Skeleton className="h-4" style={{ width: pendingWidth ?? '8rem' }} />
      ) : (
        <span className={['text-sm text-text-primary', mono ? 'font-mono text-xs' : ''].join(' ')}>
          {value}
        </span>
      )}
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
