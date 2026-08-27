import type React from 'react'
import { useState } from 'react'
import { Button } from './Button'
import { Overlay } from '@/components/ui/Overlay'
import type { DoctorResult } from '@shared/types'

interface HarnessMissingModalProps {
  doctor: DoctorResult
  onRecheck: () => Promise<void>
}

// Per-harness install guidance. Keyed by HarnessId string (kept as a plain
// string, not the shared HarnessId type, so this stays a lookup with a safe
// fallback rather than a type the renderer must keep exhaustive against
// src/main/harness/registry.ts — a harness with no entry here still gets a
// usable, if generic, "docs" link via FALLBACK_INSTALL_HINT below).
const INSTALL_HINTS: Record<string, { command: string; docsUrl: string }> = {
  claude: {
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    docsUrl: 'https://code.claude.com/docs/en/setup'
  }
}

const FALLBACK_INSTALL_HINT = { docsUrl: 'https://code.claude.com/docs/en/setup' }

export function HarnessMissingModal({
  doctor,
  onRecheck
}: HarnessMissingModalProps): React.JSX.Element {
  const [rechecking, setRechecking] = useState(false)

  async function handleRecheck(): Promise<void> {
    if (rechecking) return
    setRechecking(true)
    // Ensure the spinner stays visible for at least MIN_VISIBLE_MS — the
    // doctor IPC resolves almost instantly locally and the spinner would
    // otherwise just flash. Long enough to read the spinner; short enough
    // to still feel snappy.
    const MIN_VISIBLE_MS = 600
    const started = Date.now()
    try {
      await onRecheck()
    } finally {
      const elapsed = Date.now() - started
      if (elapsed < MIN_VISIBLE_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS - elapsed))
      }
      setRechecking(false)
    }
  }

  // This modal only ever shows when isAnyHarnessInstalled(doctor) is false
  // (see App.tsx), so every entry here is "not installed" by construction —
  // but harnesses is still whatever the doctor reported, so list them all
  // rather than assuming exactly one.
  const harnesses = doctor.harnesses
  const singular = harnesses.length === 1

  return (
    <Overlay
      open
      interactive
      dialog
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      {/* Modal card — pointer-events-auto so clicks land here, not behind */}
      <div className="relative max-w-md w-full mx-4 bg-surface-overlay border border-border-default rounded-lg p-6 flex flex-col gap-4 pointer-events-auto">
        {/* Headline row: icon + title */}
        <div className="flex items-center gap-2">
          <span className="text-yellow-400 text-lg">⚠</span>
          <h2 className="text-lg font-semibold text-text-primary">
            {singular ? 'Coding agent required' : 'No coding agent installed'}
          </h2>
        </div>

        {/* Body */}
        <p className="text-sm text-text-secondary">
          {singular
            ? 'Orpheus needs a coding agent CLI to run workspaces. Install one to continue.'
            : 'Orpheus needs at least one of the following coding agent CLIs to run workspaces. Install one to continue.'}
        </p>

        {/* Per-harness install guidance */}
        <div className="flex flex-col gap-3">
          {harnesses.map((h) => {
            const hint = INSTALL_HINTS[h.id]
            return (
              <div key={h.id} className="flex flex-col gap-2">
                {!singular && <p className="text-sm font-medium text-text-primary">{h.label}</p>}
                {hint ? (
                  <pre className="bg-surface-raised border border-border-default rounded px-3 py-2 text-xs font-mono text-text-primary overflow-x-auto">
                    {hint.command}
                  </pre>
                ) : null}
                <a
                  href={hint?.docsUrl ?? FALLBACK_INSTALL_HINT.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-text-secondary hover:text-text-primary transition-colors duration-150 cursor-pointer"
                >
                  {h.label} docs ↗
                </a>
              </div>
            )
          })}
        </div>

        {/* Action row */}
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" loading={rechecking} onClick={handleRecheck}>
            Re-check
          </Button>
        </div>

        {/* Escape-hatch hint */}
        <p className="text-xs text-text-muted">Press ⌘Q to quit Orpheus.</p>
      </div>
    </Overlay>
  )
}
