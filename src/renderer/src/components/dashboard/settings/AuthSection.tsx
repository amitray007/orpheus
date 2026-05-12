import type React from 'react'

export function AuthSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Authentication</h2>
        <p className="text-xs text-text-muted mt-1">
          API key (stored in macOS Keychain), base URL override for proxies, cloud provider
          selection (Anthropic, Bedrock, Vertex).
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will manage your Anthropic API key via macOS Keychain (never stored in plaintext), a base
          URL override for proxies or local models, and cloud provider selection between Anthropic,
          AWS Bedrock, and Google Vertex AI.
        </p>
      </div>
    </div>
  )
}
