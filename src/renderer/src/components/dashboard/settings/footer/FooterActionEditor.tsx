import { memo, useCallback, useEffect, useId, useRef, useState } from 'react'
import type React from 'react'
import type {
  FooterActionDescriptor,
  FooterActionDraft,
  FooterActionScope,
  FooterActionVisibility,
  PromptDescriptor
} from '@shared/types'
import { Select, Toggle } from '../primitives'
import { playSound } from '../../../../lib/sound'
import { IconByName } from '../../footer/iconMap'
import { IconPicker } from './IconPicker'
import { ConfirmModal } from '../../../ConfirmModal'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ActionType =
  | 'sendInput'
  | 'fork'
  | 'archive'
  | 'rename'
  | 'duplicate'
  | 'openInFinder'
  | 'openInEditor'
  | 'copyPath'
  | 'cancel'
  | 'liveUsage'
  | 'liveCost'
  | 'liveStatus'

const ACTION_TYPE_OPTIONS: { value: ActionType; label: string }[] = [
  { value: 'sendInput', label: 'Send to chat' },
  { value: 'fork', label: 'Fork workspace' },
  { value: 'archive', label: 'Archive workspace' },
  { value: 'rename', label: 'Rename workspace' },
  { value: 'duplicate', label: 'Duplicate workspace' },
  { value: 'openInFinder', label: 'Open in Finder' },
  { value: 'openInEditor', label: 'Open in Editor' },
  { value: 'copyPath', label: 'Copy path' },
  { value: 'cancel', label: 'Cancel input' },
  { value: 'liveUsage', label: 'Live indicator — Context usage' },
  { value: 'liveCost', label: 'Live indicator — Cost' },
  { value: 'liveStatus', label: 'Live indicator — Activity status' }
]

const VISIBILITY_OPTIONS: { value: FooterActionVisibility; label: string }[] = [
  { value: 'always', label: 'Always' },
  { value: 'idle', label: 'Idle only' },
  { value: 'awaitingInput', label: 'Awaiting input' }
]

// Derive the actionId from a type selection
function actionIdForType(type: ActionType): string {
  switch (type) {
    case 'sendInput':
      return 'terminal.sendInput'
    case 'fork':
      return 'workspace.fork'
    case 'archive':
      return 'workspace.archive'
    case 'rename':
      return 'workspace.rename'
    case 'duplicate':
      return 'workspace.duplicate'
    case 'openInFinder':
      return 'workspace.openInFinder'
    case 'openInEditor':
      return 'workspace.openInEditor'
    case 'copyPath':
      return 'workspace.copyPath'
    case 'cancel':
      return 'terminal.cancel'
    case 'liveUsage':
      return 'session.getUsage'
    case 'liveCost':
      return 'session.getCost'
    case 'liveStatus':
      return 'workspace.getActivityStatus'
  }
}

// Determine ActionType from a descriptor
function typeForActionId(actionId: string): ActionType {
  switch (actionId) {
    case 'terminal.sendInput':
      return 'sendInput'
    case 'workspace.fork':
      return 'fork'
    case 'workspace.archive':
      return 'archive'
    case 'workspace.rename':
      return 'rename'
    case 'workspace.duplicate':
      return 'duplicate'
    case 'workspace.openInFinder':
      return 'openInFinder'
    case 'workspace.openInEditor':
      return 'openInEditor'
    case 'workspace.copyPath':
      return 'copyPath'
    case 'terminal.cancel':
      return 'cancel'
    case 'session.getUsage':
      return 'liveUsage'
    case 'session.getCost':
      return 'liveCost'
    case 'workspace.getActivityStatus':
      return 'liveStatus'
    default:
      return 'sendInput'
  }
}

function isLiveType(type: ActionType): boolean {
  return type === 'liveUsage' || type === 'liveCost' || type === 'liveStatus'
}

// ---------------------------------------------------------------------------
// FormField — shared labeled-field wrapper (label + arbitrary control).
// Eliminates the repeated `div.flex.flex-col.gap-1` + label-class pattern.
// ---------------------------------------------------------------------------

function FormField({
  htmlFor,
  label,
  children
}: {
  htmlFor?: string
  label: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-text-secondary uppercase tracking-wide"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Preview chip
// ---------------------------------------------------------------------------

const PreviewChip = memo(function PreviewChip({
  label,
  icon,
  type,
  valid
}: {
  label: string
  icon: string | null
  type: ActionType
  valid: boolean
}): React.JSX.Element {
  const displayLabel = valid && label.trim() ? label.trim() : valid ? '…' : '—'

  if (!valid || !label.trim()) {
    return (
      <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-text-muted bg-surface-overlay/40 border border-dashed border-border-default/40">
        {icon && <IconByName name={icon} size={12} className="opacity-40" />}
        <span className="opacity-40">{displayLabel}</span>
      </span>
    )
  }

  if (isLiveType(type)) {
    return (
      <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-text-muted select-none">
        {type === 'liveStatus' ? (
          <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e]/60 flex-shrink-0" />
        ) : icon ? (
          <span className="flex-shrink-0 opacity-50">
            <IconByName name={icon} size={11} />
          </span>
        ) : null}
        <span className="truncate max-w-[120px]">{displayLabel} —</span>
      </span>
    )
  }

  return (
    <span
      className={[
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs',
        'text-text-primary bg-surface-overlay/60',
        'border border-transparent',
        'select-none'
      ].join(' ')}
    >
      <span
        className="flex-shrink-0"
        style={{ width: 12, height: 12, display: 'flex', alignItems: 'center' }}
      >
        {icon ? <IconByName name={icon} size={12} /> : null}
      </span>
      <span className="truncate max-w-[80px]">{displayLabel}</span>
    </span>
  )
})

// ---------------------------------------------------------------------------
// Type-specific config panels
// ---------------------------------------------------------------------------

interface SendInputConfigProps {
  sendText: string
  setSendText: (v: string) => void
  submit: boolean
  setSubmit: (v: boolean) => void
  sendTextId: string
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  insertPlaceholder: (placeholder: string) => void
}

const SendInputConfig = memo(function SendInputConfig({
  sendText,
  setSendText,
  submit,
  setSubmit,
  sendTextId,
  textareaRef,
  insertPlaceholder
}: SendInputConfigProps): React.JSX.Element {
  return (
    <>
      <FormField htmlFor={sendTextId} label="Text">
        <textarea
          id={sendTextId}
          ref={textareaRef}
          aria-label="Action send text"
          value={sendText}
          onChange={(e) => setSendText(e.target.value)}
          placeholder="/copy, @src/file.ts, or any text to send…"
          rows={3}
          className={[
            'w-full px-3 py-2 rounded-md text-xs bg-surface-raised border text-text-primary placeholder-text-muted',
            'outline-none focus-visible:ring-1 focus-visible:ring-accent/40 resize-none font-mono',
            sendText.length === 0 ? 'border-red-500/20' : 'border-border-default'
          ].join(' ')}
        />
        {/* Placeholder chips */}
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          <span className="text-xs text-text-muted">Insert:</span>
          {['{sessionId}', '{workspaceId}', '{cwd}'].map((ph) => (
            <button
              key={ph}
              type="button"
              onClick={() => insertPlaceholder(ph)}
              className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default text-text-muted hover:text-text-primary hover:border-border-hover transition-colors cursor-pointer"
            >
              {ph}
            </button>
          ))}
        </div>
      </FormField>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary uppercase tracking-wide">
          Submit immediately
        </span>
        <Toggle value={submit} onChange={setSubmit} ariaLabel="Submit immediately" />
      </div>
    </>
  )
})

interface RenameConfigProps {
  renamePromptLabel: string
  setRenamePromptLabel: (v: string) => void
  renamePromptDefault: string
  setRenamePromptDefault: (v: string) => void
  renamePromptLabelId: string
}

const RenameConfig = memo(function RenameConfig({
  renamePromptLabel,
  setRenamePromptLabel,
  renamePromptDefault,
  setRenamePromptDefault,
  renamePromptLabelId
}: RenameConfigProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-text-muted bg-surface-overlay/40 border border-border-default/40 rounded-md px-2.5 py-1.5 leading-relaxed">
        When clicked, a prompt will appear asking the user for the new workspace name.
      </div>
      <FormField htmlFor={renamePromptLabelId} label="Prompt label">
        <input
          id={renamePromptLabelId}
          type="text"
          aria-label="Rename prompt label"
          value={renamePromptLabel}
          onChange={(e) => setRenamePromptLabel(e.target.value)}
          placeholder="New name"
          className="w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        />
      </FormField>
      <FormField
        label={
          <>
            Default value{' '}
            <span className="text-text-muted normal-case tracking-normal">
              (use &#123;workspaceName&#125; for current name)
            </span>
          </>
        }
      >
        <input
          type="text"
          aria-label="Rename prompt default value"
          value={renamePromptDefault}
          onChange={(e) => setRenamePromptDefault(e.target.value)}
          placeholder="{workspaceName}"
          className="w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono"
        />
      </FormField>
    </div>
  )
})

interface DuplicateConfigProps {
  dupSuffix: string
  setDupSuffix: (v: string) => void
}

const DuplicateConfig = memo(function DuplicateConfig({
  dupSuffix,
  setDupSuffix
}: DuplicateConfigProps): React.JSX.Element {
  return (
    <FormField
      label={
        <>
          Name suffix{' '}
          <span className="text-text-muted normal-case tracking-normal">(optional)</span>
        </>
      }
    >
      <input
        type="text"
        aria-label="Duplicate name suffix"
        value={dupSuffix}
        onChange={(e) => setDupSuffix(e.target.value)}
        placeholder="(copy)"
        className="w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      />
    </FormField>
  )
})

// ---------------------------------------------------------------------------
// Action buttons row
// ---------------------------------------------------------------------------

interface ActionFormButtonsProps {
  isCreate: boolean
  saving: boolean
  isValid: boolean
  onDeleteClick: () => void
  onCancelClick: () => void
  onSaveClick: () => void
}

const ActionFormButtons = memo(function ActionFormButtons({
  isCreate,
  saving,
  isValid,
  onDeleteClick,
  onCancelClick,
  onSaveClick
}: ActionFormButtonsProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 pt-2 border-t border-border-default/40 flex-shrink-0">
      {!isCreate && (
        <button
          type="button"
          onClick={onDeleteClick}
          className="text-xs text-red-400 hover:text-red-300 transition-colors duration-150 px-2 py-1.5 rounded hover:bg-red-500/10 cursor-pointer mr-auto"
        >
          Delete
        </button>
      )}
      <button
        type="button"
        onClick={onCancelClick}
        className="text-xs text-text-muted hover:text-text-primary transition-colors duration-150 px-3 py-1.5 rounded hover:bg-surface-overlay cursor-pointer"
      >
        Cancel
      </button>
      <button
        type="button"
        disabled={saving || !isValid}
        onClick={onSaveClick}
        className={[
          'text-xs font-medium px-3 py-1.5 rounded transition-colors duration-150',
          saving || !isValid
            ? 'bg-accent/30 text-text-muted cursor-not-allowed'
            : 'bg-accent text-white hover:bg-accent/90 cursor-pointer'
        ].join(' ')}
      >
        {saving ? 'Saving…' : isCreate ? 'Add action' : 'Save'}
      </button>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Main editor component
// ---------------------------------------------------------------------------

interface FooterActionEditorProps {
  scope: FooterActionScope
  scopeId: string | null
  action: FooterActionDescriptor | null
  onSave: () => void
  onCancel: () => void
  onDelete: (id: string) => void
}

export function FooterActionEditor({
  scope,
  scopeId,
  action,
  onSave,
  onCancel,
  onDelete
}: FooterActionEditorProps): React.JSX.Element {
  const isCreate = action === null

  // Form state
  const [label, setLabel] = useState(action?.label ?? '')
  const [icon, setIcon] = useState<string | null>(action?.icon ?? null)
  const [actionType, setActionType] = useState<ActionType>(
    action ? typeForActionId(action.actionId) : 'sendInput'
  )
  const [sendText, setSendText] = useState<string>(
    action?.actionId === 'terminal.sendInput' ? String(action.params.text ?? '') : ''
  )
  const [submit, setSubmit] = useState<boolean>(
    action?.actionId === 'terminal.sendInput' ? Boolean(action.params.submit) : true
  )
  const [dupSuffix, setDupSuffix] = useState<string>(
    action?.actionId === 'workspace.duplicate' ? String(action.params.nameSuffix ?? '') : ''
  )
  // Prompt configuration for workspace.rename — label and pre-fill default for
  // the inline popover that collects the new name before invoking.
  const [renamePromptLabel, setRenamePromptLabel] = useState<string>(
    action?.actionId === 'workspace.rename' && action.prompts?.[0]
      ? action.prompts[0].label
      : 'New name'
  )
  const [renamePromptDefault, setRenamePromptDefault] = useState<string>(
    action?.actionId === 'workspace.rename' && action.prompts?.[0]
      ? (action.prompts[0].default ?? '{workspaceName}')
      : '{workspaceName}'
  )
  const [visibility, setVisibility] = useState<FooterActionVisibility>(
    action?.visibleWhen ?? 'always'
  )

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const labelFieldId = useId()
  const iconFieldId = useId()
  const typeFieldId = useId()
  const sendTextId = useId()
  const renamePromptLabelId = useId()
  const visibilityFieldId = useId()

  // Reset form when action changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: form fields sync to the selected action prop.
    setLabel(action?.label ?? '')
    setIcon(action?.icon ?? null)
    setActionType(action ? typeForActionId(action.actionId) : 'sendInput')
    setSendText(action?.actionId === 'terminal.sendInput' ? String(action.params.text ?? '') : '')
    setSubmit(action?.actionId === 'terminal.sendInput' ? Boolean(action.params.submit) : true)
    setDupSuffix(
      action?.actionId === 'workspace.duplicate' ? String(action.params.nameSuffix ?? '') : ''
    )
    setRenamePromptLabel(
      action?.actionId === 'workspace.rename' && action.prompts?.[0]
        ? action.prompts[0].label
        : 'New name'
    )
    setRenamePromptDefault(
      action?.actionId === 'workspace.rename' && action.prompts?.[0]
        ? (action.prompts[0].default ?? '{workspaceName}')
        : '{workspaceName}'
    )
    setVisibility(action?.visibleWhen ?? 'always')
    setError(null)
  }, [action])

  // Validation — rename is always valid once it has a label (the name is
  // collected at invocation time via the inline prompt popover).
  const labelTrimmed = label.trim()
  const isValid =
    labelTrimmed.length > 0 && (actionType !== 'sendInput' || sendText.trim().length > 0)

  const buildDraft = useCallback((): FooterActionDraft => {
    const baseActionId = actionIdForType(actionType)
    let params: Record<string, unknown> = {}
    let prompts: PromptDescriptor[] | undefined

    if (actionType === 'sendInput') {
      params = { text: sendText, submit }
    } else if (actionType === 'rename') {
      // Rename collects the new name at invocation time via a prompt popover.
      // params stay empty; the prompt descriptor carries the label and default.
      params = {}
      prompts = [
        {
          key: 'name',
          label: renamePromptLabel.trim() || 'New name',
          placeholder: 'Workspace name',
          default: renamePromptDefault
        }
      ]
    } else if (actionType === 'duplicate') {
      const suffix = dupSuffix.trim()
      params = suffix ? { nameSuffix: suffix } : {}
    }

    return {
      label: labelTrimmed,
      icon,
      actionId: baseActionId,
      params,
      visibleWhen: visibility,
      // Omit position on create so the backend assigns max(position)+1 for
      // the scope. On edit, preserve the existing position.
      ...(action !== null ? { position: action.position } : {}),
      ...(prompts ? { prompts } : {})
    }
  }, [
    actionType,
    sendText,
    submit,
    renamePromptLabel,
    renamePromptDefault,
    dupSuffix,
    labelTrimmed,
    icon,
    visibility,
    action
  ])

  const handleSave = useCallback(async (): Promise<void> => {
    if (!isValid) {
      playSound('error')
      setError(
        labelTrimmed.length === 0
          ? 'Label is required.'
          : 'Text is required for "Send to chat" actions.'
      )
      return
    }

    setSaving(true)
    setError(null)

    try {
      const draft = buildDraft()
      if (isCreate) {
        await window.api.footerActions.create(scope, scopeId, draft)
      } else {
        await window.api.footerActions.update(action!.id, draft)
      }
      playSound('success')
      onSave()
    } catch (err) {
      playSound('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [isValid, labelTrimmed, buildDraft, isCreate, scope, scopeId, action, onSave])

  async function handleDelete(): Promise<void> {
    if (!action) return
    try {
      await window.api.footerActions.remove(action.id)
      playSound('pop')
      onDelete(action.id)
    } catch (err) {
      playSound('error')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setShowDeleteConfirm(false)
    }
  }

  // Insert placeholder at cursor position in the sendText textarea
  const insertPlaceholder = useCallback(
    (placeholder: string) => {
      const el = textareaRef.current
      if (!el) {
        setSendText((t) => t + placeholder)
        return
      }
      const start = el.selectionStart
      const end = el.selectionEnd
      const next = sendText.slice(0, start) + placeholder + sendText.slice(end)
      setSendText(next)
      // Restore focus + cursor after insert
      setTimeout(() => {
        el.focus()
        el.setSelectionRange(start + placeholder.length, start + placeholder.length)
      }, 0)
    },
    [sendText]
  )

  // Stable handlers passed to the memoized ActionFormButtons child
  const handleDeleteClick = useCallback(() => {
    playSound('click')
    setShowDeleteConfirm(true)
  }, [])

  const handleCancelClick = useCallback(() => {
    playSound('click')
    onCancel()
  }, [onCancel])

  const handleSaveClick = useCallback(() => {
    handleSave().catch((e) => console.error('[FooterActionEditor] save failed', e))
  }, [handleSave])

  const scopeLabel = scope === 'global' ? 'global' : 'project'

  return (
    <>
      {showDeleteConfirm && action && (
        <ConfirmModal
          title="Delete action?"
          body={
            <p className="text-sm text-text-secondary">
              This will permanently remove <strong>{action.label}</strong> from {scopeLabel}{' '}
              actions.
            </p>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      <div className="flex flex-col gap-4 h-full">
        {/* Header */}
        <div className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {isCreate ? 'New action' : 'Edit action'}
        </div>

        {/* Form fields */}
        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto">
          {/* Label */}
          <FormField htmlFor={labelFieldId} label="Label">
            <input
              id={labelFieldId}
              type="text"
              aria-label="Action label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Fork, Copy context…"
              className={[
                'w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border text-text-primary placeholder-text-muted',
                'outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                label.length > 0 && labelTrimmed.length === 0
                  ? 'border-red-500/40'
                  : 'border-border-default'
              ].join(' ')}
            />
          </FormField>

          {/* Icon */}
          <FormField htmlFor={iconFieldId} label="Icon">
            <IconPicker id={iconFieldId} value={icon} onChange={setIcon} />
          </FormField>

          {/* Type */}
          <FormField htmlFor={typeFieldId} label="Type">
            <Select
              options={ACTION_TYPE_OPTIONS}
              value={actionType}
              onChange={(v) => setActionType(v)}
              ariaLabel="Action type"
              id={typeFieldId}
              className="w-full"
            />
          </FormField>

          {/* Per-type conditional fields */}
          {actionType === 'sendInput' && (
            <SendInputConfig
              sendText={sendText}
              setSendText={setSendText}
              submit={submit}
              setSubmit={setSubmit}
              sendTextId={sendTextId}
              textareaRef={textareaRef}
              insertPlaceholder={insertPlaceholder}
            />
          )}

          {actionType === 'rename' && (
            <RenameConfig
              renamePromptLabel={renamePromptLabel}
              setRenamePromptLabel={setRenamePromptLabel}
              renamePromptDefault={renamePromptDefault}
              setRenamePromptDefault={setRenamePromptDefault}
              renamePromptLabelId={renamePromptLabelId}
            />
          )}

          {actionType === 'duplicate' && (
            <DuplicateConfig dupSuffix={dupSuffix} setDupSuffix={setDupSuffix} />
          )}

          {/* Visibility */}
          <FormField htmlFor={visibilityFieldId} label="Visible when">
            <Select
              options={VISIBILITY_OPTIONS}
              value={visibility}
              onChange={(v) => setVisibility(v)}
              ariaLabel="Visible when"
              id={visibilityFieldId}
              className="w-full"
            />
          </FormField>

          {/* Live preview */}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-secondary uppercase tracking-wide">
              Preview
            </span>
            <div className="flex items-center gap-2 px-3 py-2 bg-surface-raised/50 rounded-md border border-border-default/40 min-h-[36px]">
              <PreviewChip label={labelTrimmed} icon={icon} type={actionType} valid={isValid} />
              <span className="text-xs text-text-muted">
                {isLiveType(actionType) ? '· right zone' : '· left zone'}
              </span>
            </div>
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-2">
              {error}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <ActionFormButtons
          isCreate={isCreate}
          saving={saving}
          isValid={isValid}
          onDeleteClick={handleDeleteClick}
          onCancelClick={handleCancelClick}
          onSaveClick={handleSaveClick}
        />
      </div>
    </>
  )
}
