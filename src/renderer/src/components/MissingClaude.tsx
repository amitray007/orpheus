import { Button } from './Button'

interface MissingClaudeProps {
  onRecheck: () => void
}

export function MissingClaude({ onRecheck }: MissingClaudeProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-center w-full h-full">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        {/* Wordmark */}
        <h1 className="text-5xl font-bold tracking-tight text-text-primary">
          Orpheus<span className="text-accent">.</span>
        </h1>

        {/* Headline */}
        <h2 className="text-2xl font-semibold text-text-primary mt-2">
          Claude Code isn't installed yet
        </h2>

        {/* Body */}
        <p className="text-sm text-text-secondary leading-relaxed">
          Orpheus is built around the <code className="text-accent font-mono">claude</code> CLI.
          Install Claude Code, then re-check below.
        </p>

        {/* Install command */}
        <pre className="w-full rounded-lg bg-surface-raised border border-border-default px-4 py-3 text-sm font-mono text-text-primary text-left overflow-x-auto">
          {/* TODO: verify the exact Claude Code install command — this is a placeholder.
              Real command at https://docs.claude.com/en/docs/claude-code/setup
              or https://claude.com/code/install */}
          curl -fsSL https://claude.ai/install.sh | sh
        </pre>

        {/* Docs link — Electron's setWindowOpenHandler already forwards target="_blank"
            clicks to shell.openExternal, so a plain anchor is sufficient */}
        <a
          href="https://docs.anthropic.com/en/docs/claude-code/setup"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-accent hover:text-accent-hover transition-colors duration-150"
        >
          Read the docs →
        </a>

        {/* Re-check */}
        <Button variant="primary" size="md" onClick={onRecheck} className="mt-2">
          Re-check
        </Button>
      </div>
    </div>
  )
}
