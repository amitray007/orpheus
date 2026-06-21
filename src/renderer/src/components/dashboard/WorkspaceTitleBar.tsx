/* eslint-disable react-refresh/only-export-components -- file exports both component and cache-eviction utility by design */
import { useEffect, useState } from 'react'
import type React from 'react'
import { Terminal as TerminalIcon, Folder, Gear, ArrowBendUpLeft, Cpu } from '@phosphor-icons/react'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'
import type { GhPullRequest, WorkspaceRecord } from '@shared/types'
import { PrChip } from '../github/PrChip'

// ---------------------------------------------------------------------------
// Model label helper — derives a short human-readable label from a model ID.
// ---------------------------------------------------------------------------
function modelLabel(modelId: string): string {
  // 1. Exact match in known options
  const known = CLAUDE_MODEL_OPTIONS.find((o) => o.value === modelId)
  if (known) return known.label

  // 2. Prefix match — handles date-stamped variants like "claude-opus-4-7-20260416"
  //    by finding the longest known option whose value is a prefix of the incoming ID.
  const prefixMatch = CLAUDE_MODEL_OPTIONS.filter((o) => modelId.startsWith(o.value)).sort(
    (a, b) => b.value.length - a.value.length
  )[0]
  if (prefixMatch) return prefixMatch.label

  // 3. Structural parse: "claude-<family>-<v1>-<v2>..." → "<Family> <v1>.<v2>"
  //    Strips the leading "claude-" then splits on "-".
  //    family = first segment (capitalized), version = subsequent numeric segments joined by ".".
  const parts = modelId.replace(/^claude-/, '').split('-')
  if (parts.length >= 1) {
    const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
    const versionParts = parts.slice(1).filter((p) => /^\d/.test(p))
    if (versionParts.length > 0) {
      return `${family} ${versionParts.join('.')}`
    }
    return family
  }

  return modelId
}

// ---------------------------------------------------------------------------
// Context label helper — formats a token count as a human-readable string.
// ---------------------------------------------------------------------------
function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M ctx`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`
  return `${tokens} ctx`
}

// ---------------------------------------------------------------------------
// ModelContextChip — small read-only chip showing model + context mode.
// Fetches context budget once on mount; stays static until workspace changes.
//
// Module-level cache: seeded on first fetch per workspace, invalidated when
// the session ID changes (handled by the workspaceId + sessionId key below).
// On switch-back the chip renders the stale value immediately (no layout shift
// or late-appear flash) while the fresh fetch runs in the background.
// ---------------------------------------------------------------------------

type ContextBudgetInfo = { contextBudget: number; modelId: string }

// Keyed by `${workspaceId}:${claudeSessionId}` so the cache is automatically
// invalidated when the session changes (new conversation in same workspace).
const contextBudgetCache = new Map<string, ContextBudgetInfo>()

/**
 * Evicts all context-budget cache entries for a workspace that has been
 * archived or removed. Prefix-matches `${workspaceId}:` to cover every
 * session key that belongs to that workspace.
 */
export function clearContextBudgetCache(workspaceId: string): void {
  const prefix = `${workspaceId}:`
  for (const key of contextBudgetCache.keys()) {
    if (key.startsWith(prefix)) contextBudgetCache.delete(key)
  }
}

interface ModelContextChipProps {
  workspaceId: string
  /** claudeSessionId — used as part of the cache key so the chip
   *  re-fetches when the session changes (workspace restarts, forks, etc.). */
  claudeSessionId: string | null
}

function ModelContextChip({
  workspaceId,
  claudeSessionId
}: ModelContextChipProps): React.JSX.Element | null {
  const cacheKey = `${workspaceId}:${claudeSessionId ?? ''}`
  const cached = contextBudgetCache.get(cacheKey) ?? null
  const [info, setInfo] = useState<ContextBudgetInfo | null>(cached)

  useEffect(() => {
    let cancelled = false
    const key = `${workspaceId}:${claudeSessionId ?? ''}`

    // Serve cache immediately; still revalidate so the chip stays fresh after
    // a session's first message (context budget updates as tokens are used).
    const stale = contextBudgetCache.get(key)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: seed chip from cache on workspace/session change before async result arrives
    if (stale) setInfo(stale)

    window.api.sessions
      .getContextBudget(workspaceId)
      .then((result) => {
        if (!cancelled && result) {
          // Skip caching for pre-session workspaces (claudeSessionId === null)
          // so a stale model chip isn't shown after a global model change.
          if (claudeSessionId !== null) {
            contextBudgetCache.set(key, result)
          }
          setInfo(result)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [workspaceId, claudeSessionId])

  if (!info) return null

  const label = `${modelLabel(info.modelId)} · ${contextLabel(info.contextBudget)}`

  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-text-muted bg-surface-overlay border border-border-default/50 rounded px-1.5 py-0.5 flex-shrink-0 leading-none"
      title={`Model: ${info.modelId} · Context: ${info.contextBudget.toLocaleString()} tokens`}
    >
      <Cpu size={10} className="flex-shrink-0 opacity-60" />
      <span>{label}</span>
    </span>
  )
}

interface WorkspaceTitleBarProps {
  workspace: WorkspaceRecord
  drawer: null | 'status' | 'overrides'
  onSetDrawer: (drawer: null | 'status' | 'overrides') => void
  pr?: GhPullRequest | null
  /** All workspaces — used to resolve the parent workspace name for forked-from chip. */
  allWorkspaces?: WorkspaceRecord[]
}

export function WorkspaceTitleBar({
  workspace,
  drawer,
  onSetDrawer,
  pr,
  allWorkspaces
}: WorkspaceTitleBarProps): React.JSX.Element {
  const [terminalTitle, setTerminalTitle] = useState<string | null>(null)

  useEffect(() => {
    const workspaceId = workspace.id
    window.api.workspaces
      .getTitle(workspaceId)
      .then(setTerminalTitle)
      .catch(() => {})
    return window.api.workspaces.onTitleChanged((e) => {
      if (e.workspaceId === workspaceId) setTerminalTitle(e.title || null)
    })
  }, [workspace.id])

  // Resolve parent name for the "forked from" chip
  const forkedFromSessionId = workspace.forkedFromSessionId ?? null
  let forkedFromName: string | null = null
  if (forkedFromSessionId && allWorkspaces) {
    const parent = allWorkspaces.find((w) => w.claudeSessionId === forkedFromSessionId)
    forkedFromName = parent ? parent.name : null
  }

  return (
    <div
      className="flex items-center gap-2 min-w-0 flex-1 px-3"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <TerminalIcon size={13} className="text-text-muted flex-shrink-0" />
      <span
        className="text-xs font-medium text-text-primary truncate"
        title={
          workspace.nameIsAuto && terminalTitle && terminalTitle !== workspace.name
            ? `${workspace.name} — ${terminalTitle}`
            : workspace.name
        }
      >
        {workspace.nameIsAuto ? terminalTitle || workspace.name : workspace.name}
      </span>

      {/* PR chip appears next to the workspace name when the current branch
          has a PR on GitHub. Hides cleanly when no PR. */}
      {pr && (
        <span className="flex-shrink-0">
          <PrChip pr={pr} variant="chip" />
        </span>
      )}

      {/* Forked-from chip — shown when this workspace was forked from another session */}
      {forkedFromSessionId && (
        <span
          className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-muted bg-surface-overlay/50 border border-border-default/40"
          title={
            forkedFromName ? `Forked from: ${forkedFromName}` : 'Forked from another workspace'
          }
        >
          <ArrowBendUpLeft size={9} className="flex-shrink-0" />
          {forkedFromName ? `forked from ${forkedFromName}` : 'forked'}
        </span>
      )}

      {/* Model + context chip — read-only, fetched from main via IPC */}
      <ModelContextChip workspaceId={workspace.id} claudeSessionId={workspace.claudeSessionId} />

      <span className="text-text-muted text-xs">·</span>
      <span
        className="text-xs text-text-muted truncate flex items-center gap-1 min-w-0"
        title={workspace.cwd}
      >
        <Folder size={10} className="flex-shrink-0" />
        {workspace.cwd}
      </span>

      <button
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => onSetDrawer(drawer === 'overrides' ? null : 'overrides')}
        title="Workspace Settings"
        aria-label="Workspace Settings"
        className={[
          'ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0',
          'transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          drawer === 'overrides'
            ? 'bg-surface-overlay text-text-primary'
            : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
      >
        <Gear size={14} />
        <span>Workspace Settings</span>
      </button>
    </div>
  )
}
