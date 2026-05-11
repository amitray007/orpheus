import type React from 'react'

interface FooterProps {
  version: string
  connected: boolean
}

export function Footer({ version, connected }: FooterProps): React.JSX.Element {
  return (
    <footer className="h-7 flex items-center justify-between px-4 bg-surface-raised border-t border-border-default shrink-0">
      <span className="text-xs text-text-muted">Orpheus {version}</span>
      {connected && (
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          Connected
        </span>
      )}
    </footer>
  )
}
