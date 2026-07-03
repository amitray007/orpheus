import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CaretDown, Plus, Pencil, Trash } from '@phosphor-icons/react'
import type { ProjectRecord } from '@shared/types'
import { ConfirmModal } from '../../ConfirmModal'
import { SectionTitle, Eyebrow } from './primitives'
import { useEscapeKey } from '../../../lib/useEscapeKey'
import { SourceSelect } from './shared/SourceSelect'

// ---------------------------------------------------------------------------
// FrontmatterCollectionSection — generic frontmatter-file collection editor.
//
// Shared shape behind ClaudeSubagentsSection (~/.claude/agents/) and
// ClaudeSlashCommandsSection (~/.claude/commands/): both are CRUD editors
// over a directory of frontmatter+body markdown files, with grouping by
// source (user vs. per-project), a create/edit form, per-row rendering with
// hover-reveal edit/delete, an expandable drawer showing extra frontmatter
// keys + body preview, and a delete-confirm modal.
//
// Callers supply the CRUD quad, the field schema (with layout-row grouping),
// every copy string, and a name formatter — every visual/behavioral detail
// that differed between the two original implementations is parameterized
// here rather than assumed.
// ---------------------------------------------------------------------------

export interface EntityBase {
  name: string
  path: string
  source: 'user' | 'project'
  projectId?: string
  projectName?: string
  description: string | null
  frontmatter: Record<string, string | string[]>
  bodyPreview: string
}

interface EntityGroup<T extends EntityBase> {
  key: string
  label: string
  items: T[]
}

function groupEntities<T extends EntityBase>(items: T[], userLabel: string): EntityGroup<T>[] {
  const groups: EntityGroup<T>[] = []

  const userItems = items.filter((i) => i.source === 'user')
  if (userItems.length > 0) {
    groups.push({ key: 'user', label: userLabel, items: userItems })
  }

  const projectGroups = new Map<string, EntityGroup<T>>()
  for (const i of items) {
    if (i.source !== 'project' || !i.projectId) continue
    let group = projectGroups.get(i.projectId)
    if (!group) {
      group = {
        key: `project:${i.projectId}`,
        label: `Project · ${i.projectName ?? i.projectId}`,
        items: []
      }
      projectGroups.set(i.projectId, group)
    }
    group.items.push(i)
  }
  for (const g of projectGroups.values()) groups.push(g)

  return groups
}

// ---------------------------------------------------------------------------
// Field schema — declarative form layout. Each row holds 1-3 fields so the
// exact "which fields share a row" layout of each original form is
// reproducible rather than approximated.
// ---------------------------------------------------------------------------

export type FormValues = Record<string, string>

export interface FieldSpec {
  /** Key into FormValues. */
  key: string
  label: string
  /** Extra normal-case hint appended after the label, e.g. "(empty = inherit)". */
  labelHint?: string
  type: 'text' | 'textarea'
  placeholder?: string
  rows?: number // textarea only
  monospace?: boolean // textarea only (body field)
  /** Flex sizing for the containing div: 'flex-1' (default) or a fixed width class. */
  widthClassName?: string
  /** id/htmlFor suffix — combined with idPrefix, e.g. `${idPrefix}-${idSuffix}`. */
  idSuffix: string
}

export type FieldRow = FieldSpec[]

export interface ChipSpec<T extends EntityBase> {
  /** Render the chip's text content for a given item, or null to omit it. */
  render: (item: T) => string | null
  monospace?: boolean
  /** Optional title attribute, e.g. full tool list on hover. */
  title?: (item: T) => string | undefined
}

export interface FrontmatterCollectionConfig<T extends EntityBase, D> {
  idPrefix: string
  promotedKeys: Set<string>
  fieldRows: FieldRow[]
  /** Chips rendered inline after the name in the row header (in order). */
  chips: ChipSpec<T>[]
  /** True when names should be shown/read with a leading '/' everywhere (slash commands). */
  namePrefix?: string
  copy: {
    title: string
    description: string
    eyebrowLabel: string
    addButtonLabel: string
    addButtonAriaLabel: string
    formAriaLabel: string
    namePlaceholder: string
    descriptionPlaceholder: string
    emptyStateLine1: string
    emptyStateLine2: string
    deleteTitle: string
    deleteBodyText: string
    userSourceLabel: string
    userGroupLabel: string
  }
  /** Build initial form values for a brand-new draft. */
  defaultValues: FormValues
  /** Map an existing entity to form values (edit form initial state). */
  toFormValues: (item: T) => FormValues
  /** Map form values -> create draft (source/projectId always included). */
  toCreateDraft: (values: FormValues) => D
  /** Map form values -> update draft (source/projectId omitted). */
  toUpdateDraft: (values: FormValues) => Omit<D, 'source' | 'projectId'>
  api: {
    list: () => Promise<T[]>
    add: (draft: D) => Promise<void>
    update: (path: string, draft: Omit<D, 'source' | 'projectId'>) => Promise<void>
    delete: (path: string) => Promise<void>
  }
  logScope: string
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

interface CollectionFormProps<T extends EntityBase, D> {
  config: FrontmatterCollectionConfig<T, D>
  initial: FormValues
  projects: ProjectRecord[]
  sourceFixed?: boolean
  nameFixed?: boolean
  onSave: (values: FormValues) => Promise<void>
  onCancel: () => void
  addButtonRef?: React.RefObject<HTMLButtonElement | null>
}

function CollectionFormInner<T extends EntityBase, D>({
  config,
  initial,
  projects,
  sourceFixed,
  nameFixed,
  onSave,
  onCancel,
  addButtonRef
}: CollectionFormProps<T, D>): React.JSX.Element {
  const [values, setValues] = useState<FormValues>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const firstInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    // When the source is fixed (editing existing), jump straight to the name
    // input. Otherwise the Select primitive autofocuses its trigger via
    // autoFocus={!sourceFixed} on SourceSelect below.
    if (sourceFixed) firstInputRef.current?.focus()
  }, [sourceFixed])

  useEscapeKey(() => {
    onCancel()
    addButtonRef?.current?.focus()
  })

  function set(key: string, val: string): void {
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

  const { idPrefix } = config

  return (
    <form
      className="bg-surface-raised border border-border-default rounded-lg p-4 flex flex-col gap-3"
      aria-label={config.copy.formAriaLabel}
      onSubmit={(e) => e.preventDefault()}
    >
      {/* Row 1: Source + Name (+ any other row-1 fields, e.g. Model) */}
      <div className="flex gap-3">
        <SourceSelect
          userLabel={config.copy.userSourceLabel}
          value={values.source === 'user' ? 'user' : values.projectId}
          projects={projects}
          onChange={(source, projectId) => {
            set('source', source)
            set('projectId', projectId)
          }}
          disabled={sourceFixed}
          autoFocus={!sourceFixed}
        />

        {/* Name */}
        <div className="flex-1 min-w-0">
          <label htmlFor={`${idPrefix}-name`} className={labelClass}>
            Name{' '}
            {nameFixed && (
              <span className="normal-case text-text-muted">(locked — delete to rename)</span>
            )}
          </label>
          <input
            id={`${idPrefix}-name`}
            ref={firstInputRef}
            type="text"
            placeholder={config.copy.namePlaceholder}
            disabled={nameFixed}
            value={values.name ?? ''}
            onChange={(e) => set('name', e.target.value)}
            className={inputClass}
          />
        </div>

        {config.fieldRows[0]?.map((field) => (
          <div key={field.key} className={`${field.widthClassName ?? 'flex-1 min-w-0'}`}>
            <label htmlFor={`${idPrefix}-${field.idSuffix}`} className={labelClass}>
              {field.label}{' '}
              {field.labelHint && (
                <span className="normal-case text-text-muted">{field.labelHint}</span>
              )}
            </label>
            <input
              id={`${idPrefix}-${field.idSuffix}`}
              type="text"
              placeholder={field.placeholder}
              value={values[field.key] ?? ''}
              onChange={(e) => set(field.key, e.target.value)}
              className={inputClass}
            />
          </div>
        ))}
      </div>

      {/* Description */}
      <div>
        <label htmlFor={`${idPrefix}-description`} className={labelClass}>
          Description
        </label>
        <textarea
          id={`${idPrefix}-description`}
          rows={2}
          placeholder={config.copy.descriptionPlaceholder}
          value={values.description ?? ''}
          onChange={(e) => set('description', e.target.value)}
          className={`${inputClass} resize-y`}
        />
      </div>

      {/* Remaining field rows (row index 1+) */}
      {config.fieldRows.slice(1).map((row, rowIdx) => (
        <div key={rowIdx} className={row.length > 1 ? 'flex gap-3' : undefined}>
          {row.map((field) => {
            const wrapperClass = row.length > 1 ? (field.widthClassName ?? 'flex-1 min-w-0') : ''
            const control =
              field.type === 'textarea' ? (
                <textarea
                  id={`${idPrefix}-${field.idSuffix}`}
                  rows={field.rows ?? 2}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ''}
                  onChange={(e) => set(field.key, e.target.value)}
                  className={`${inputClass} resize-y ${field.monospace ? 'font-mono' : ''}`}
                />
              ) : (
                <input
                  id={`${idPrefix}-${field.idSuffix}`}
                  type="text"
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ''}
                  onChange={(e) => set(field.key, e.target.value)}
                  className={inputClass}
                />
              )
            return (
              <div key={field.key} className={wrapperClass}>
                <label htmlFor={`${idPrefix}-${field.idSuffix}`} className={labelClass}>
                  {field.label}{' '}
                  {field.labelHint && (
                    <span className="normal-case text-text-muted">{field.labelHint}</span>
                  )}
                </label>
                {control}
              </div>
            )
          })}
        </div>
      ))}

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
}

// memo() erases generic type params (returns a plain NamedExoticComponent),
// so we cast back through unknown to preserve <T, D> at call sites.
const CollectionForm = memo(CollectionFormInner) as unknown as typeof CollectionFormInner

// ---------------------------------------------------------------------------
// Row — memoized display row (non-editing state)
// ---------------------------------------------------------------------------

interface CollectionRowProps<T extends EntityBase, D> {
  config: FrontmatterCollectionConfig<T, D>
  item: T
  isExpanded: boolean
  onToggleExpand: (path: string) => void
  onEdit: (path: string) => void
  onDelete: (item: T) => void
}

function CollectionRowInner<T extends EntityBase, D>({
  config,
  item,
  isExpanded,
  onToggleExpand,
  onEdit,
  onDelete
}: CollectionRowProps<T, D>): React.JSX.Element {
  const extraKeys = Object.keys(item.frontmatter).filter((k) => !config.promotedKeys.has(k))
  const prefix = config.namePrefix ?? ''
  const displayName = `${prefix}${item.name}`

  return (
    <div className="group border-b border-border-default/40 last:border-b-0">
      {/* Row header */}
      <div className="flex items-start justify-between py-2.5 gap-3">
        <button
          type="button"
          onClick={() => onToggleExpand(item.path)}
          className="flex-1 flex items-start justify-between gap-3 text-left cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
          aria-expanded={isExpanded}
          aria-label={`${displayName} — ${isExpanded ? 'collapse' : 'expand'}`}
        >
          <div className="flex flex-col min-w-0 gap-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-text-primary font-medium">{displayName}</span>
              {config.chips.map((chip, i) => {
                const text = chip.render(item)
                if (!text) return null
                return (
                  <span
                    key={i}
                    className={`text-xs text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 flex-shrink-0 ${chip.monospace ? 'font-mono' : ''}`}
                    title={chip.title?.(item)}
                  >
                    {text}
                  </span>
                )
              })}
            </div>
            {item.description && (
              <p className="text-xs text-text-muted truncate">{item.description}</p>
            )}
          </div>
          <CaretDown
            size={14}
            className="flex-shrink-0 mt-0.5 text-text-muted transition-transform duration-150"
            style={{ transform: isExpanded ? 'rotate(180deg)' : 'none' }}
            aria-hidden="true"
          />
        </button>

        {/* Row actions (hover-reveal) */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
          <button
            type="button"
            aria-label={`Edit ${displayName}`}
            onClick={() => onEdit(item.path)}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${displayName}`}
            onClick={() => onDelete(item)}
            className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <Trash size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Expanded drawer */}
      {isExpanded && (
        <div className="border-t border-border-default/40 ml-0 pl-3 border-l border-border-default/40 mb-2 pt-2 pb-1 flex flex-col gap-2">
          {item.description && (
            <p className="text-xs text-text-secondary leading-relaxed">{item.description}</p>
          )}
          {extraKeys.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {extraKeys.map((k) => {
                const v = item.frontmatter[k]
                const display = Array.isArray(v) ? v.join(', ') : v
                return (
                  <div key={k} className="flex gap-2 text-sm">
                    <span className="text-text-muted font-mono flex-shrink-0">{k}:</span>
                    <span className="text-text-secondary break-all">{display}</span>
                  </div>
                )
              })}
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wider text-text-muted">Body</span>
            {item.bodyPreview ? (
              <div className="font-mono whitespace-pre-wrap text-sm text-text-secondary leading-relaxed bg-surface-overlay rounded px-2 py-1.5">
                {item.bodyPreview}
              </div>
            ) : (
              <p className="text-sm text-text-muted italic">(no body content)</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const CollectionRow = memo(CollectionRowInner) as unknown as typeof CollectionRowInner

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FrontmatterCollectionSection<T extends EntityBase, D>({
  config
}: {
  config: FrontmatterCollectionConfig<T, D>
}): React.JSX.Element {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [deletingItem, setDeletingItem] = useState<T | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const list = await config.api.list()
      setItems(list)
    } catch (err) {
      console.error(`[${config.logScope}] reload failed`, err)
    }
  }, [config.api, config.logScope])

  useEffect(() => {
    config.api
      .list()
      .then((list) => {
        setItems(list)
        setLoading(false)
      })
      .catch((err) => {
        console.error(`[${config.logScope}] load failed`, err)
        setLoading(false)
      })
    window.api.projects
      .list()
      .then(setProjects)
      .catch(() => {})
    // Intentionally run once on mount — config identity is stable per section.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCancelAdd = useCallback((): void => {
    setAdding(false)
    addButtonRef.current?.focus()
  }, [])

  const handleCancelEdit = useCallback((): void => {
    setEditingPath(null)
  }, [])

  const handleToggleExpand = useCallback((path: string): void => {
    setExpandedPath((cur) => (cur === path ? null : path))
  }, [])

  const handleEditStart = useCallback((path: string): void => {
    setEditingPath(path)
    setAdding(false)
    setExpandedPath(null)
  }, [])

  const handleDeleteRequest = useCallback((item: T): void => {
    setDeletingItem(item)
  }, [])

  async function handleAdd(values: FormValues): Promise<void> {
    const draft = config.toCreateDraft(values)
    await config.api.add(draft)
    await reload()
    setAdding(false)
  }

  async function handleUpdate(item: T, values: FormValues): Promise<void> {
    const draft = config.toUpdateDraft(values)
    await config.api.update(item.path, draft)
    await reload()
    setEditingPath(null)
  }

  async function handleDelete(item: T): Promise<void> {
    await config.api.delete(item.path)
    await reload()
    setDeletingItem(null)
  }

  const prefix = config.namePrefix ?? ''

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <SectionTitle>{config.copy.title}</SectionTitle>
        <p className="text-xs text-text-muted mt-1">{config.copy.description}</p>
      </div>

      {/* Header + add button */}
      <div className="flex items-center justify-between">
        <Eyebrow>{config.copy.eyebrowLabel}</Eyebrow>
        <button
          ref={addButtonRef}
          type="button"
          aria-label={config.copy.addButtonAriaLabel}
          onClick={() => {
            setAdding(true)
            setEditingPath(null)
          }}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <Plus size={12} weight="bold" aria-hidden="true" />
          {config.copy.addButtonLabel}
        </button>
      </div>

      {/* Add form */}
      {adding && (
        <CollectionForm
          config={config}
          initial={config.defaultValues}
          projects={projects}
          onSave={handleAdd}
          onCancel={handleCancelAdd}
          addButtonRef={addButtonRef}
        />
      )}

      <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
        {loading ? (
          <CollectionSkeleton />
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
            <p className="text-xs text-text-muted">{config.copy.emptyStateLine1}</p>
            <p className="text-xs text-text-muted mt-1">{config.copy.emptyStateLine2}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groupEntities(items, config.copy.userGroupLabel).map((group) => (
              <div key={group.key} className="flex flex-col">
                <div className="text-xs uppercase tracking-wider text-text-muted mb-1.5">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  if (editingPath === item.path) {
                    return (
                      <div key={`${group.key}:${item.path}`} className="mb-2">
                        <CollectionForm
                          config={config}
                          initial={config.toFormValues(item)}
                          projects={projects}
                          sourceFixed
                          nameFixed
                          onSave={(values) => handleUpdate(item, values)}
                          onCancel={handleCancelEdit}
                          addButtonRef={addButtonRef}
                        />
                      </div>
                    )
                  }
                  return (
                    <CollectionRow
                      key={`${group.key}:${item.path}`}
                      config={config}
                      item={item}
                      isExpanded={expandedPath === item.path}
                      onToggleExpand={handleToggleExpand}
                      onEdit={handleEditStart}
                      onDelete={handleDeleteRequest}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirm modal */}
      {deletingItem && (
        <ConfirmModal
          title={config.copy.deleteTitle}
          body={
            <div className="flex flex-col gap-2">
              <p>{config.copy.deleteBodyText}</p>
              <code className="text-xs font-mono bg-surface-overlay border border-border-default rounded px-2 py-1.5 break-all">
                {prefix}
                {deletingItem.name}
              </code>
            </div>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => handleDelete(deletingItem)}
          onCancel={() => setDeletingItem(null)}
        />
      )}
    </div>
  )
}

function CollectionSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-1.5 py-2.5">
          <div className="flex items-center gap-2">
            <div className="h-4 w-28 rounded bg-surface-overlay" />
            <div className="h-4 w-14 rounded bg-surface-overlay" />
          </div>
          <div className="h-3 w-48 rounded bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}
