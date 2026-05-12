import type React from 'react'

export function PermissionsSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Permissions</h2>
        <p className="text-xs text-text-muted mt-1">
          Daily-use toggles (auto-approve edits, ask on git push) plus a raw allow/ask/deny rule
          editor for power users. Additional directory allowlist.
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will provide daily-use toggles for common cases (auto-approve edits, ask on git push)
          alongside a collapsible raw rule editor for allow/ask/deny permission policies and an
          additional directory allowlist for power users.
        </p>
      </div>
    </div>
  )
}
