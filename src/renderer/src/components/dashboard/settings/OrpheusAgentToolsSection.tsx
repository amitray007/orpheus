import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight, ArrowCounterClockwise } from '@phosphor-icons/react'
import type {
  ControlToolCategoryPreference,
  ControlToolPreference,
  ControlToolsSettings
} from '@shared/types'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { Eyebrow, SectionTitle } from './primitives'

type SaveKey = `category:${string}` | `tool:${string}` | 'reset:all'

function hasControlToolOverrides(settings: ControlToolsSettings): boolean {
  return (
    settings.categories.some((category) => category.override !== null) ||
    settings.tools.some((tool) => tool.override !== null)
  )
}

function isToolControlDisabled(tool: ControlToolPreference, saving: boolean): boolean {
  return saving || !tool.categoryEnabled
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ExposureToggle({
  value,
  disabled,
  ariaLabel,
  describedBy,
  onChange
}: {
  value: boolean
  disabled: boolean
  ariaLabel: string
  describedBy?: string
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={[
        'relative inline-flex items-center w-9 h-5 rounded-full transition-[background-color,opacity,transform] duration-150',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
        'active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45',
        disabled ? '' : 'cursor-pointer',
        value ? 'bg-accent' : 'bg-surface-overlay'
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={[
          'inline-block w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-150',
          value ? 'translate-x-[18px]' : 'translate-x-[2px]'
        ].join(' ')}
      />
    </button>
  )
}

function ResetButton({
  label,
  disabled,
  saving,
  onClick
}: {
  label: string
  disabled: boolean
  saving: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border-default text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-[color,background-color,transform,opacity] duration-150 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <ArrowCounterClockwise size={12} aria-hidden="true" />
      {saving ? 'Resetting…' : label}
    </button>
  )
}

function ToolRow({
  tool,
  saving,
  pendingKey,
  onUpdate,
  onReset
}: {
  tool: ControlToolPreference
  saving: boolean
  pendingKey: SaveKey | null
  onUpdate: (tool: ControlToolPreference, enabled: boolean) => void
  onReset: (tool: ControlToolPreference) => void
}): React.JSX.Element {
  const disabledByCategoryId = `tool-disabled-${tool.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const disabled = isToolControlDisabled(tool, saving)
  const isPending = pendingKey === `tool:${tool.id}`
  return (
    <div
      className={[
        'flex flex-col gap-3 px-4 py-3 border-t border-border-default/40 sm:flex-row sm:items-start sm:justify-between',
        tool.categoryEnabled ? '' : 'bg-surface-overlay/25'
      ].join(' ')}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="text-xs font-mono text-text-primary break-all">{tool.id}</code>
          <span className="text-[10px] uppercase tracking-wider text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5">
            {tool.kind}
          </span>
          <span
            className={[
              'text-[10px] uppercase tracking-wider border rounded px-1.5 py-0.5',
              tool.riskTier >= 2
                ? 'text-amber-400 border-amber-400/25 bg-amber-400/5'
                : 'text-text-muted border-border-default bg-surface-overlay'
            ].join(' ')}
          >
            Risk {tool.riskTier}
          </span>
          {tool.override !== null && (
            <span className="text-[10px] text-accent uppercase tracking-wider">Customized</span>
          )}
        </div>
        <p className="text-xs text-text-muted mt-1 leading-relaxed">{tool.description}</p>
        {!tool.categoryEnabled && (
          <p id={disabledByCategoryId} className="text-xs text-text-muted mt-1">
            Disabled by the {tool.category} category.
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-start">
        {tool.override !== null && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onReset(tool)}
            className="px-2 py-1 text-xs text-text-muted hover:text-text-primary rounded hover:bg-surface-overlay transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? 'Resetting…' : 'Use default'}
          </button>
        )}
        <ExposureToggle
          value={tool.enabled}
          disabled={disabled}
          ariaLabel={`${tool.id} exposed to agents`}
          describedBy={!tool.categoryEnabled ? disabledByCategoryId : undefined}
          onChange={(enabled) => onUpdate(tool, enabled)}
        />
      </div>
    </div>
  )
}

function CategoryCard({
  category,
  tools,
  expanded,
  saving,
  pendingKey,
  onToggleExpanded,
  onUpdateCategory,
  onResetCategory,
  onUpdateTool,
  onResetTool
}: {
  category: ControlToolCategoryPreference
  tools: ControlToolPreference[]
  expanded: boolean
  saving: boolean
  pendingKey: SaveKey | null
  onToggleExpanded: () => void
  onUpdateCategory: (category: ControlToolCategoryPreference, enabled: boolean) => void
  onResetCategory: (category: ControlToolCategoryPreference) => void
  onUpdateTool: (tool: ControlToolPreference, enabled: boolean) => void
  onResetTool: (tool: ControlToolPreference) => void
}): React.JSX.Element {
  const panelId = `agent-tools-category-${category.id}`
  const isPending = pendingKey === `category:${category.id}`
  return (
    <article className="bg-surface-raised border border-border-default rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggleExpanded}
          className="flex flex-1 items-center gap-2 min-w-0 text-left rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          {expanded ? (
            <CaretDown size={14} className="text-text-muted flex-shrink-0" aria-hidden="true" />
          ) : (
            <CaretRight size={14} className="text-text-muted flex-shrink-0" aria-hidden="true" />
          )}
          <span className="text-sm font-medium text-text-primary">{category.label}</span>
          <span className="text-xs text-text-muted">
            {category.toolCount} {category.toolCount === 1 ? 'tool' : 'tools'}
          </span>
          {category.override !== null && (
            <span className="text-[10px] text-accent uppercase tracking-wider">Customized</span>
          )}
        </button>
        <div className="flex items-center gap-2 flex-shrink-0">
          {category.override !== null && (
            <button
              type="button"
              disabled={saving}
              onClick={() => onResetCategory(category)}
              className="px-2 py-1 text-xs text-text-muted hover:text-text-primary rounded hover:bg-surface-overlay transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isPending ? 'Resetting…' : 'Use default'}
            </button>
          )}
          <ExposureToggle
            value={category.enabled}
            disabled={saving}
            ariaLabel={`${category.label} tools exposed to agents`}
            onChange={(enabled) => onUpdateCategory(category, enabled)}
          />
        </div>
      </div>
      {expanded && (
        <div id={panelId}>
          {tools.length > 0 ? (
            tools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                saving={saving}
                pendingKey={pendingKey}
                onUpdate={onUpdateTool}
                onReset={onResetTool}
              />
            ))
          ) : (
            <p className="px-10 py-3 border-t border-border-default/40 text-xs text-text-muted">
              No MCP tools are registered in this category.
            </p>
          )}
        </div>
      )}
    </article>
  )
}

const header = (
  <div id="setting-agent-tools">
    <div className="flex flex-wrap items-center gap-2">
      <SectionTitle>Agent Tools</SectionTitle>
      <span className="text-[10px] uppercase tracking-wider text-emerald-400 bg-emerald-400/5 border border-emerald-400/20 rounded px-1.5 py-0.5">
        Available by default
      </span>
    </div>
    <p className="text-xs text-text-muted mt-1 max-w-xl leading-relaxed">
      All Orpheus semantic tools are available to agents by default. Turn off a category or
      operation to hide it from MCP discovery and block its use. These are exposure controls, not
      permission prompts.
    </p>
  </div>
)

export function OrpheusAgentToolsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ControlToolsSettings | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [savingError, setSavingError] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<SaveKey | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async (): Promise<void> => {
    setLoadingError(null)
    try {
      setSettings(await window.api.controlTools.get())
    } catch (error) {
      setLoadingError(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.controlTools
      .get()
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch((error) => {
        if (!cancelled) setLoadingError(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function save(key: SaveKey, request: () => Promise<ControlToolsSettings>): Promise<void> {
    if (pendingKey !== null) return
    setPendingKey(key)
    setSavingError(null)
    try {
      setSettings(await request())
    } catch (error) {
      setSavingError(errorMessage(error))
    } finally {
      setPendingKey(null)
    }
  }

  const saving = pendingKey !== null

  if (settings === null && loadingError === null) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        {header}
        <SettingsSectionSkeleton groups={1} rowsPerGroup={5} />
      </div>
    )
  }

  if (settings === null) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        {header}
        <div role="alert" className="bg-red-400/5 border border-red-400/20 rounded-lg p-4">
          <p className="text-sm text-red-400">Couldn’t load Agent Tools.</p>
          <p className="text-xs text-text-muted mt-1">{loadingError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 px-3 py-1.5 rounded-md border border-border-default text-xs text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-[color,background-color,transform] duration-150 active:scale-[0.97]"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  const customized = hasControlToolOverrides(settings)

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      {header}

      <section id="setting-tool-categories" className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-4">
          <div>
            <Eyebrow>Tool categories</Eyebrow>
            <p className="text-xs text-text-muted mt-1">
              Expand a category to fine-tune individual operations.
            </p>
          </div>
          <ResetButton
            label="Reset all"
            saving={pendingKey === 'reset:all'}
            disabled={saving || !customized}
            onClick={() =>
              void save('reset:all', () => window.api.controlTools.reset({ target: 'all' }))
            }
          />
        </div>

        {savingError && (
          <div
            role="alert"
            className="text-xs text-red-400 bg-red-400/5 border border-red-400/20 rounded-md px-3 py-2"
          >
            Couldn’t save Agent Tools: {savingError}
          </div>
        )}

        <p className="sr-only" role="status" aria-live="polite">
          {saving
            ? 'Saving Agent Tools settings.'
            : customized
              ? 'Agent Tools settings saved.'
              : 'All Agent Tools are using their defaults.'}
        </p>

        <div id="setting-individual-tools" className="flex flex-col gap-2">
          {settings.categories.map((category) => (
            <CategoryCard
              key={category.id}
              category={category}
              tools={settings.tools.filter((tool) => tool.category === category.id)}
              expanded={expanded.has(category.id)}
              saving={saving}
              pendingKey={pendingKey}
              onToggleExpanded={() =>
                setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(category.id)) next.delete(category.id)
                  else next.add(category.id)
                  return next
                })
              }
              onUpdateCategory={(item, enabled) =>
                void save(`category:${item.id}`, () =>
                  window.api.controlTools.update({
                    target: 'category',
                    id: item.id,
                    enabled
                  })
                )
              }
              onResetCategory={(item) =>
                void save(`category:${item.id}`, () =>
                  window.api.controlTools.reset({ target: 'category', id: item.id })
                )
              }
              onUpdateTool={(tool, enabled) =>
                void save(`tool:${tool.id}`, () =>
                  window.api.controlTools.update({ target: 'tool', id: tool.id, enabled })
                )
              }
              onResetTool={(tool) =>
                void save(`tool:${tool.id}`, () =>
                  window.api.controlTools.reset({ target: 'tool', id: tool.id })
                )
              }
            />
          ))}
        </div>
      </section>

      <section
        id="setting-reset-agent-tools"
        className="flex items-start justify-between gap-5 bg-surface-raised border border-border-default rounded-lg px-5 py-4"
      >
        <div>
          <p className="text-sm font-medium text-text-primary">Default exposure</p>
          <p className="text-xs text-text-muted mt-1">
            Reset removes every customization and makes all registered semantic tools available
            again.
          </p>
        </div>
        <ResetButton
          label="Reset all"
          saving={pendingKey === 'reset:all'}
          disabled={saving || !customized}
          onClick={() =>
            void save('reset:all', () => window.api.controlTools.reset({ target: 'all' }))
          }
        />
      </section>
    </div>
  )
}
