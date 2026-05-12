import { useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// ClaudeAuthSection — cloud provider, API key, base URL
// ---------------------------------------------------------------------------

export function ClaudeAuthSection(): React.JSX.Element {
  const [providerOpen, setProviderOpen] = useState(false)

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Authentication</h2>
        <p className="text-xs text-text-muted mt-1">
          API key (stored in macOS Keychain), base URL override for proxies, and cloud provider
          selection (Anthropic, Bedrock, Vertex, Foundry).
        </p>
      </div>

      {/* Provider selection */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Cloud provider
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow label="Provider" description="Which cloud backend Claude Code connects to.">
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Anthropic', 'Bedrock', 'Vertex', 'Foundry'] as const).map((p) => (
                  <span
                    key={p}
                    className={[
                      'px-3 py-1.5 text-xs font-medium rounded',
                      p === 'Anthropic' ? 'bg-accent/15 text-text-primary' : 'text-text-muted'
                    ].join(' ')}
                  >
                    {p}
                  </span>
                ))}
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Credentials */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Credentials
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="API key"
            description="Stored securely in macOS Keychain — never written to disk in plaintext."
          >
            <div className="flex items-center gap-2">
              <input
                disabled
                type="password"
                placeholder="sk-ant-…"
                className="w-48 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono opacity-50 cursor-not-allowed"
              />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Base URL override"
            description="Proxy or local model endpoint. Leave blank to use the provider default."
          >
            <div className="flex items-center gap-2">
              <input
                disabled
                placeholder="https://…"
                className="w-48 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono opacity-50 cursor-not-allowed"
              />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Provider-specific config (collapsible) */}
      <section className="flex flex-col">
        <button
          onClick={() => setProviderOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-secondary mb-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
        >
          {providerOpen ? (
            <CaretDown size={12} weight="bold" />
          ) : (
            <CaretRight size={12} weight="bold" />
          )}
          Provider-specific config
        </button>
        {providerOpen && (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-text-primary">
                Bedrock / Vertex / Foundry options
              </span>
              <ComingSoonChip />
            </div>
            <p className="text-xs text-text-muted italic">
              AWS region, GCP project ID, IAM role ARN, and other provider-specific fields will
              appear here once provider config is wired.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
