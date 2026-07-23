import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import type React from 'react'
import { Plus, Pencil, Trash } from '@phosphor-icons/react'
import type {
  ClaudeGlobalSettings,
  DiscoveredMcpServer,
  McpServerDraft,
  ProjectRecord
} from '@shared/types'
import { SettingRow, Toggle, NumberInput, Select, SectionTitle, Eyebrow } from './primitives'
import { ConfirmModal } from '../../ConfirmModal'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { useEscapeKey } from '../../../lib/useEscapeKey'
import { SourceSelect } from './shared/SourceSelect'

// ---------------------------------------------------------------------------
// ClaudeToolsSection — MCP servers (full CRUD), bash limits, concurrency, browser integration
// ---------------------------------------------------------------------------

type McpGroup = {
  key: string
  label: string
  filePath: string
  servers: DiscoveredMcpServer[]
}

function groupServers(servers: DiscoveredMcpServer[]): McpGroup[] {
  const groups: McpGroup[] = []

  const userServers = servers.filter((s) => s.source === 'user')
  if (userServers.length > 0) {
    groups.push({
      key: 'user',
      label: 'User · ~/.claude.json',
      filePath: userServers[0]!.filePath,
      servers: userServers
    })
  }

  const projectGroups = new Map<string, McpGroup>()
  for (const s of servers) {
    if (s.source !== 'project' || !s.projectId) continue
    let group = projectGroups.get(s.projectId)
    if (!group) {
      group = {
        key: `project:${s.projectId}`,
        label: `Project · ${s.projectName ?? s.projectId}`,
        filePath: s.filePath,
        servers: []
      }
      projectGroups.set(s.projectId, group)
    }
    group.servers.push(s)
  }
  for (const g of projectGroups.values()) groups.push(g)

  return groups
}

// ---------------------------------------------------------------------------
// McpServerForm — add / edit form
// ---------------------------------------------------------------------------

interface McpFormValues {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command: string
  argsRaw: string // comma-separated string for stdio args
  envRaw: string // KEY=VALUE lines for stdio env
  url: string
  source: 'user' | 'project'
  projectId: string
  showAdvanced: boolean
}

interface McpServerFormProps {
  initial: McpFormValues
  projects: ProjectRecord[]
  sourceFixed?: boolean
  onSave: (values: McpFormValues) => Promise<void>
  onCancel: () => void
  addButtonRef?: React.RefObject<HTMLButtonElement | null>
}

const McpServerForm = memo(function McpServerForm({
  initial,
  projects,
  sourceFixed,
  onSave,
  onCancel,
  addButtonRef
}: McpServerFormProps): React.JSX.Element {
  const [values, setValues] = useState<McpFormValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement | null>(null)
  const transportId = useId()

  useEffect(() => {
    firstInputRef.current?.focus()
  }, [])

  useEscapeKey(() => {
    onCancel()
    addButtonRef?.current?.focus()
  })

  function set<K extends keyof McpFormValues>(key: K, val: McpFormValues[K]): void {
    setValues((prev) => ({ ...prev, [key]: val }))
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await onSave(values)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full text-xs bg-surface-overlay border border-border-default rounded-md px-2.5 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/50 disabled:opacity-50'
  const labelClass = 'block text-xs font-medium text-text-muted mb-1 uppercase tracking-wider'
  const isStdio = values.transport === 'stdio'

  return (
    <form
      className="bg-surface-raised border border-border-default rounded-lg p-4 flex flex-col gap-3"
      aria-label="MCP server"
      onSubmit={(e) => e.preventDefault()}
    >
      {/* Row 1: Source + Name + Transport */}
      <div className="flex gap-3">
        <SourceSelect
          userLabel="User (~/.claude.json)"
          value={values.source === 'user' ? 'user' : values.projectId}
          projects={projects}
          onChange={(source, projectId) => {
            set('source', source)
            set('projectId', projectId)
          }}
          disabled={sourceFixed}
        />

        {/* Name */}
        <div className="flex-1 min-w-0">
          <label htmlFor="mcp-name" className={labelClass}>
            Name
          </label>
          <input
            id="mcp-name"
            ref={firstInputRef}
            type="text"
            placeholder="my-server"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSave().catch(() => {})
              }
            }}
            className={inputClass}
          />
        </div>

        {/* Transport */}
        <div className="w-28 flex-shrink-0">
          <label htmlFor={transportId} className={labelClass}>
            Transport
          </label>
          <Select<'stdio' | 'http' | 'sse'>
            ariaLabel="Transport"
            id={transportId}
            value={values.transport}
            onChange={(v) => set('transport', v)}
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'http', label: 'http' },
              { value: 'sse', label: 'sse' }
            ]}
          />
        </div>
      </div>

      {/* Stdio: Command */}
      {isStdio && (
        <div>
          <label htmlFor="mcp-command" className={labelClass}>
            Command
          </label>
          <input
            id="mcp-command"
            type="text"
            placeholder="npx my-mcp-server"
            value={values.command}
            onChange={(e) => set('command', e.target.value)}
            className={inputClass}
          />
        </div>
      )}

      {/* HTTP/SSE: URL */}
      {!isStdio && (
        <div>
          <label htmlFor="mcp-url" className={labelClass}>
            URL
          </label>
          <input
            id="mcp-url"
            type="text"
            placeholder="https://my-server.example.com/mcp"
            value={values.url}
            onChange={(e) => set('url', e.target.value)}
            className={inputClass}
          />
        </div>
      )}

      {/* Advanced toggle (stdio only) */}
      {isStdio && (
        <div>
          <button
            type="button"
            onClick={() => set('showAdvanced', !values.showAdvanced)}
            className="text-xs uppercase tracking-wider text-accent hover:text-accent/80 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
          >
            {values.showAdvanced ? '▲ Hide advanced' : '▶ Show advanced (args, env)'}
          </button>
        </div>
      )}

      {/* Advanced fields */}
      {isStdio && values.showAdvanced && (
        <div className="flex flex-col gap-3 border-l-2 border-border-default/40 pl-3">
          <div>
            <label htmlFor="mcp-args" className={labelClass}>
              Args <span className="normal-case text-text-muted">(comma-separated)</span>
            </label>
            <input
              id="mcp-args"
              type="text"
              placeholder="--port, 3000, --verbose"
              value={values.argsRaw}
              onChange={(e) => set('argsRaw', e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="mcp-env" className={labelClass}>
              Env vars <span className="normal-case text-text-muted">(one KEY=VALUE per line)</span>
            </label>
            <textarea
              id="mcp-env"
              rows={3}
              placeholder={'API_KEY=abc123\nDEBUG=true'}
              value={values.envRaw}
              onChange={(e) => set('envRaw', e.target.value)}
              className={`${inputClass} font-mono resize-y`}
            />
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-3 py-2"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            handleSave().catch(() => {})
          }}
          disabled={saving}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => {
            onCancel()
            addButtonRef?.current?.focus()
          }}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
        >
          Cancel
        </button>
      </div>
    </form>
  )
})

// ---------------------------------------------------------------------------
// McpServerRow — memoized display row (non-editing state)
// ---------------------------------------------------------------------------

interface McpServerRowProps {
  server: DiscoveredMcpServer
  enabled: boolean
  onEdit: (server: DiscoveredMcpServer) => void
  onDelete: (server: DiscoveredMcpServer) => void
  onToggleEnabled: (name: string, enabled: boolean) => void
}

const McpServerRow = memo(function McpServerRow({
  server,
  enabled,
  onEdit,
  onDelete,
  onToggleEnabled
}: McpServerRowProps): React.JSX.Element {
  return (
    <div className="group flex items-center justify-between py-2 border-b border-border-default/40 last:border-b-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-text-primary truncate">{server.name}</span>
        <span className="text-xs uppercase tracking-wider text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 flex-shrink-0">
          {server.transport}
        </span>
        {server.command && (
          <span
            className="text-xs text-text-muted font-mono truncate max-w-[180px]"
            title={server.command}
          >
            {server.command}
          </span>
        )}
        {server.url && (
          <span
            className="text-xs text-text-muted font-mono truncate max-w-[180px]"
            title={server.url}
          >
            {server.url}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Row actions (hover-reveal) */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            aria-label={`Edit ${server.name}`}
            onClick={() => onEdit(server)}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${server.name}`}
            onClick={() => onDelete(server)}
            className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <Trash size={12} aria-hidden="true" />
          </button>
        </div>
        <Toggle
          ariaLabel={`${server.name} enabled`}
          value={enabled}
          onChange={(v) => onToggleEnabled(server.name, v)}
        />
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Helpers to convert form values ↔ draft
// ---------------------------------------------------------------------------

function parseEnvRaw(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const k = trimmed.slice(0, eqIdx).trim()
    const v = trimmed.slice(eqIdx + 1)
    if (k) env[k] = v
  }
  return env
}

function serverToFormValues(s: DiscoveredMcpServer): McpFormValues {
  const envEntries = s.env
    ? Object.entries(s.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : ''
  const hasAdvanced = Boolean(
    (s.args && s.args.length > 0) || (s.env && Object.keys(s.env).length > 0)
  )
  return {
    name: s.name,
    transport: s.transport === 'unknown' ? 'stdio' : s.transport,
    command: s.command ?? '',
    argsRaw: s.args ? s.args.join(', ') : '',
    envRaw: envEntries,
    url: s.url ?? '',
    source: s.source,
    projectId: s.projectId ?? '',
    showAdvanced: hasAdvanced
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const defaultAddDraft: McpFormValues = {
  name: '',
  transport: 'stdio',
  command: '',
  argsRaw: '',
  envRaw: '',
  url: '',
  source: 'user',
  projectId: '',
  showAdvanced: false
}

export function ClaudeToolsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)
  const [servers, setServers] = useState<DiscoveredMcpServer[]>([])
  const [serversLoading, setServersLoading] = useState(true)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [adding, setAdding] = useState(false)
  const [editingServer, setEditingServer] = useState<DiscoveredMcpServer | null>(null)
  const [deletingServer, setDeletingServer] = useState<DiscoveredMcpServer | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((err) => console.error('[tools-settings] load failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    window.api.mcp
      .listServers()
      .then((s) => {
        setServers(s)
        setServersLoading(false)
      })
      .catch((err) => {
        console.error('[tools-settings] mcp list failed', err)
        setServersLoading(false)
      })
    window.api.projects
      .list()
      .then(setProjects)
      .catch(() => {})
  }, [])

  const handleCancelAdd = useCallback((): void => {
    setAdding(false)
    addButtonRef.current?.focus()
  }, [])

  const handleCancelEdit = useCallback((): void => {
    setEditingServer(null)
  }, [])

  const handleEditStart = useCallback((server: DiscoveredMcpServer): void => {
    setEditingServer(server)
    setAdding(false)
  }, [])

  const handleDeleteRequest = useCallback((server: DiscoveredMcpServer): void => {
    setDeletingServer(server)
  }, [])

  async function reloadServers(): Promise<void> {
    try {
      const s = await window.api.mcp.listServers()
      setServers(s)
    } catch (err) {
      console.error('[mcp] reload failed', err)
    }
  }

  const patch = useCallback(
    (p: Partial<ClaudeGlobalSettings>): void => {
      if (!settings) return
      setSettings({ ...settings, ...p })
      window.api.claudeSettings.update(p).catch((err) => {
        console.error('[tools-settings] update failed; refetching', err)
        window.api.claudeSettings
          .get()
          .then((s) => setSettings(s))
          .catch(console.error)
      })
    },
    [settings]
  )

  const toggleMcpServer = useCallback(
    (name: string, enabled: boolean): void => {
      if (!settings) return
      const disabled = new Set(settings.disabledMcpServers)
      if (enabled) disabled.delete(name)
      else disabled.add(name)
      patch({ disabledMcpServers: Array.from(disabled).sort() })
    },
    [settings, patch]
  )

  async function handleAdd(values: McpFormValues): Promise<void> {
    const draft: McpServerDraft = {
      name: values.name.trim(),
      transport: values.transport,
      command: values.transport === 'stdio' ? values.command.trim() : undefined,
      args:
        values.transport === 'stdio' && values.argsRaw.trim()
          ? values.argsRaw.split(',').flatMap((s) => {
              const v = s.trim()
              return v ? [v] : []
            })
          : undefined,
      env:
        values.transport === 'stdio' && values.envRaw.trim()
          ? parseEnvRaw(values.envRaw)
          : undefined,
      url: values.transport !== 'stdio' ? values.url.trim() : undefined,
      source: values.source,
      projectId: values.source === 'project' ? values.projectId : undefined
    }
    await window.api.mcp.add(draft)
    await reloadServers()
    setAdding(false)
  }

  async function handleUpdate(server: DiscoveredMcpServer, values: McpFormValues): Promise<void> {
    const draft: Omit<McpServerDraft, 'source' | 'projectId'> = {
      name: values.name.trim(),
      transport: values.transport,
      command: values.transport === 'stdio' ? values.command.trim() : undefined,
      args:
        values.transport === 'stdio' && values.argsRaw.trim()
          ? values.argsRaw.split(',').flatMap((s) => {
              const v = s.trim()
              return v ? [v] : []
            })
          : undefined,
      env:
        values.transport === 'stdio' && values.envRaw.trim()
          ? parseEnvRaw(values.envRaw)
          : undefined,
      url: values.transport !== 'stdio' ? values.url.trim() : undefined
    }
    await window.api.mcp.update(server.filePath, server.name, draft)
    await reloadServers()
    setEditingServer(null)
  }

  async function handleDelete(server: DiscoveredMcpServer): Promise<void> {
    await window.api.mcp.delete(server.filePath, server.name)
    await reloadServers()
    setDeletingServer(null)
  }

  if (!settings) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Tools</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            MCP server toggles, Bash limits, tool concurrency, and browser integration.
          </p>
        </div>
        <SettingsSectionSkeleton groups={3} rowsPerGroup={2} />
      </div>
    )
  }

  const groups = groupServers(servers)
  const disabledMcpSet = new Set(settings.disabledMcpServers)

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Tools</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          MCP server toggles (auto-discovered from ~/.claude.json and each project&apos;s
          .mcp.json), Bash limits, tool concurrency, and browser integration. Changes save
          automatically.
        </p>
      </div>

      {/* MCP servers */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Eyebrow>MCP servers</Eyebrow>
          <button
            ref={addButtonRef}
            type="button"
            aria-label="Add MCP server"
            onClick={() => {
              setAdding(true)
              setEditingServer(null)
            }}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <Plus size={12} weight="bold" aria-hidden="true" />
            Add server
          </button>
        </div>

        {/* Add form */}
        {adding && (
          <McpServerForm
            initial={defaultAddDraft}
            projects={projects}
            onSave={handleAdd}
            onCancel={handleCancelAdd}
            addButtonRef={addButtonRef}
          />
        )}

        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          {serversLoading ? (
            <McpSkeleton />
          ) : servers.length === 0 && !adding ? (
            <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
              <p className="text-xs text-text-muted">
                No MCP servers configured in ~/.claude.json or any project&apos;s .mcp.json
              </p>
              <p className="text-xs text-text-muted mt-1">
                Use &quot;Add server&quot; above or edit the files directly.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map((group) => (
                <div key={group.key} className="flex flex-col">
                  <div className="text-xs uppercase tracking-wider text-text-muted mb-1.5">
                    {group.label}
                  </div>
                  {group.servers.map((s) => {
                    const isEditing =
                      editingServer?.name === s.name && editingServer?.filePath === s.filePath

                    if (isEditing) {
                      return (
                        <div key={`${group.key}:${s.name}`} className="mb-2">
                          <McpServerForm
                            initial={serverToFormValues(s)}
                            projects={projects}
                            sourceFixed
                            onSave={(values) => handleUpdate(s, values)}
                            onCancel={handleCancelEdit}
                            addButtonRef={addButtonRef}
                          />
                        </div>
                      )
                    }

                    return (
                      <McpServerRow
                        key={`${group.key}:${s.name}`}
                        server={s}
                        enabled={!disabledMcpSet.has(s.name)}
                        onEdit={handleEditStart}
                        onDelete={handleDeleteRequest}
                        onToggleEnabled={toggleMcpServer}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Delete confirm modal */}
      {deletingServer && (
        <ConfirmModal
          title="Delete MCP server?"
          body={
            <div className="flex flex-col gap-2">
              <p>This will permanently remove the server from the config file.</p>
              <code className="text-xs font-mono bg-surface-overlay border border-border-default rounded px-2 py-1.5 break-all">
                {deletingServer.name}
              </code>
            </div>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => handleDelete(deletingServer)}
          onCancel={() => setDeletingServer(null)}
        />
      )}

      {/* Bash limits */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Bash limits</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Bash default timeout (ms)"
            description="Default timeout in milliseconds for each Bash command. Leave empty to use claude's default (120000 ms)."
            mapsTo="BASH_DEFAULT_TIMEOUT_MS"
          >
            <NumberInput
              value={settings.bashDefaultTimeoutMs}
              onChange={(v) => patch({ bashDefaultTimeoutMs: v })}
              placeholder="120000"
            />
          </SettingRow>
          <SettingRow
            label="Bash max timeout (ms)"
            description="Maximum timeout a user may request for a single Bash command. Leave empty to use claude's default (600000 ms)."
            mapsTo="BASH_MAX_TIMEOUT_MS"
          >
            <NumberInput
              value={settings.bashMaxTimeoutMs}
              onChange={(v) => patch({ bashMaxTimeoutMs: v })}
              placeholder="600000"
            />
          </SettingRow>
          <SettingRow
            label="Bash max output length"
            description="Maximum characters of stdout/stderr captured per command. Leave empty to let claude auto-truncate."
            mapsTo="BASH_MAX_OUTPUT_LENGTH"
          >
            <NumberInput
              value={settings.bashMaxOutputLength}
              onChange={(v) => patch({ bashMaxOutputLength: v })}
              placeholder="auto-truncate"
            />
          </SettingRow>
        </div>
      </section>

      {/* Concurrency & integrations */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Concurrency &amp; integrations</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Tool concurrency"
            description="How many tools Claude may run in parallel in a single turn. Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY"
          >
            <NumberInput
              value={settings.toolConcurrency}
              onChange={(v) => patch({ toolConcurrency: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Tool call timeout (ms)"
            description="Maximum time a single tool call may run before being aborted (CLAUDE_CODE_TOOL_CALL_TIMEOUT_MS). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_TOOL_CALL_TIMEOUT_MS"
          >
            <NumberInput
              value={settings.toolCallTimeoutMs}
              onChange={(v) => patch({ toolCallTimeoutMs: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Max tool output length"
            description="Maximum characters of output captured across all tools, not just Bash (CLAUDE_CODE_MAX_TOOL_OUTPUT_LENGTH). Leave empty to let claude auto-truncate."
            mapsTo="CLAUDE_CODE_MAX_TOOL_OUTPUT_LENGTH"
          >
            <NumberInput
              value={settings.maxToolOutputLength}
              onChange={(v) => patch({ maxToolOutputLength: v })}
              placeholder="auto-truncate"
            />
          </SettingRow>
          <SettingRow
            label="Browser integration"
            description="Enable claude's Chrome browser integration for web browsing and interaction."
          >
            <Toggle
              ariaLabel="Browser integration enabled"
              value={settings.browserIntegration}
              onChange={(v) => patch({ browserIntegration: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable Artifact tool"
            description="Prevent Claude from using the Artifact tool for publishing private web pages (CLAUDE_CODE_DISABLE_ARTIFACT=1)."
            mapsTo="CLAUDE_CODE_DISABLE_ARTIFACT"
          >
            <Toggle
              ariaLabel="Disable Artifact tool"
              value={settings.disableArtifact}
              onChange={(v) => patch({ disableArtifact: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable advisor tool"
            description="Prevent Claude from using the server-side advisor tool (CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1)."
            mapsTo="CLAUDE_CODE_DISABLE_ADVISOR_TOOL"
          >
            <Toggle
              ariaLabel="Disable advisor tool"
              value={settings.disableAdvisorTool}
              onChange={(v) => patch({ disableAdvisorTool: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* File operations */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">File operations</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Bash maintains project cwd"
            description="Each Bash command resets its working directory to the project root (CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1)."
            mapsTo="CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR"
          >
            <Toggle
              ariaLabel="Bash maintains project cwd"
              value={settings.bashMaintainCwd}
              onChange={(v) => patch({ bashMaintainCwd: v })}
            />
          </SettingRow>
          <SettingRow
            label="Perforce mode"
            description="Enable Perforce VCS integration for source control operations (CLAUDE_CODE_PERFORCE_MODE=1)."
            mapsTo="CLAUDE_CODE_PERFORCE_MODE"
          >
            <Toggle
              ariaLabel="Perforce mode"
              value={settings.perforceMode}
              onChange={(v) => patch({ perforceMode: v })}
            />
          </SettingRow>
          <SettingRow
            label="Glob includes hidden files (override)"
            description="When enabled, sets CLAUDE_CODE_GLOB_HIDDEN=1. Note: claude's default already includes hidden files. To force-exclude them, use Custom env vars to set CLAUDE_CODE_GLOB_HIDDEN=0."
            mapsTo="CLAUDE_CODE_GLOB_HIDDEN"
          >
            <Toggle
              ariaLabel="Glob includes hidden files override"
              value={settings.globHidden}
              onChange={(v) => patch({ globHidden: v })}
            />
          </SettingRow>
          <SettingRow
            label="Glob ignores .gitignore (override)"
            description="When enabled, sets CLAUDE_CODE_GLOB_NO_IGNORE=1 so globs skip .gitignore patterns. To force-enable .gitignore respect, use Custom env vars to set CLAUDE_CODE_GLOB_NO_IGNORE=0."
            mapsTo="CLAUDE_CODE_GLOB_NO_IGNORE"
          >
            <Toggle
              ariaLabel="Glob ignores .gitignore override"
              value={settings.globNoIgnore}
              onChange={(v) => patch({ globNoIgnore: v })}
            />
          </SettingRow>
          <SettingRow
            label="Glob timeout (seconds)"
            description="Maximum seconds to spend on a single glob operation (CLAUDE_CODE_GLOB_TIMEOUT_SECONDS). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_GLOB_TIMEOUT_SECONDS"
          >
            <NumberInput
              value={settings.globTimeoutSeconds}
              onChange={(v) => patch({ globTimeoutSeconds: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Disable file checkpointing"
            description="Prevent Claude from creating file snapshots before edits for potential rollback (CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1)."
            mapsTo="CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING"
          >
            <Toggle
              ariaLabel="Disable file checkpointing"
              value={settings.disableFileCheckpointing}
              onChange={(v) => patch({ disableFileCheckpointing: v })}
            />
          </SettingRow>
          <SettingRow
            label="Rewind on error"
            description="Automatically roll back file checkpoints when a tool call errors out (CLAUDE_CODE_REWIND_ON_ERROR_ENABLED=1)."
            mapsTo="CLAUDE_CODE_REWIND_ON_ERROR_ENABLED"
          >
            <Toggle
              ariaLabel="Rewind on error"
              value={settings.rewindOnErrorEnabled}
              onChange={(v) => patch({ rewindOnErrorEnabled: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable attachments"
            description="Prevent users from attaching files to Claude sessions (CLAUDE_CODE_DISABLE_ATTACHMENTS=1)."
            mapsTo="CLAUDE_CODE_DISABLE_ATTACHMENTS"
          >
            <Toggle
              ariaLabel="Disable attachments"
              value={settings.disableAttachments}
              onChange={(v) => patch({ disableAttachments: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Shell */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Shell</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Shell override"
            description="Use a specific shell binary instead of the default for Bash tool invocations (CLAUDE_CODE_SHELL)."
            mapsTo="CLAUDE_CODE_SHELL"
          >
            <input
              type="text"
              aria-label="Shell override"
              value={settings.shellOverride}
              onChange={(e) => patch({ shellOverride: e.target.value })}
              onBlur={(e) => patch({ shellOverride: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="/bin/zsh"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
          <SettingRow
            label="Shell prefix"
            description="Prepend a command prefix to every Bash invocation, e.g. to lower process priority (CLAUDE_CODE_SHELL_PREFIX)."
            mapsTo="CLAUDE_CODE_SHELL_PREFIX"
          >
            <input
              type="text"
              aria-label="Shell prefix"
              value={settings.shellPrefix}
              onChange={(e) => patch({ shellPrefix: e.target.value })}
              onBlur={(e) => patch({ shellPrefix: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="nice -n 19"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
          <SettingRow
            label="Source ~/.zshrc before Claude"
            description="Source your full ~/.zshrc before Claude starts. Off by default for faster launch; turn on if your shell setup (aliases, tool managers) lives in .zshrc."
            mapsTo="ORPHEUS_SOURCE_ZSHRC"
          >
            <Toggle
              ariaLabel="Source ~/.zshrc before Claude"
              value={settings.sourceZshrc}
              onChange={(v) => patch({ sourceZshrc: v })}
            />
          </SettingRow>
          <SettingRow
            label="Custom shell before Claude"
            description='Runs as you, in your shell, right before Claude starts. Use it to load tools like direnv or nvm. Example: eval "$(direnv export zsh)"'
            mapsTo="ORPHEUS_PRE_LAUNCH_SNIPPET"
          >
            <textarea
              aria-label="Custom shell before Claude"
              value={settings.preLaunchSnippet}
              onChange={(e) => patch({ preLaunchSnippet: e.target.value })}
              onBlur={(e) => patch({ preLaunchSnippet: e.target.value.trim() })}
              placeholder='eval "$(direnv export zsh)"'
              className="w-full min-h-[76px] px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono resize-y cursor-text"
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

function McpSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <div className="h-4 w-32 rounded bg-surface-overlay" />
            <div className="h-4 w-10 rounded bg-surface-overlay" />
          </div>
          <div className="h-5 w-9 rounded-full bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}
