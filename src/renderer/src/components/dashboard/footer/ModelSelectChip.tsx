import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'
import type { ChipDropdownItem } from '@shared/types'
import { IconByName } from './iconMap'
import { showChipDropdown, hideChipDropdown, chipDropdownId } from '@/lib/overlayClient'

// ---------------------------------------------------------------------------
// ModelSelectChip — the footer's built-in "Model" chip. Unlike ActionChip,
// this doesn't invoke a registered action; it opens a chipDropdown popover
// listing CLAUDE_MODEL_OPTIONS, persists the pick via workspace:setModel
// (which also suppresses the "Restart to apply" dirty flag, since the pick
// is applied live via `/model <value>` immediately after), and shows the
// EFFECTIVE model (workspace override → project override → global setting)
// as its face text — not the static "Model" label, which is used as the
// dropdown title / tooltip prefix instead.
// ---------------------------------------------------------------------------

const DROPDOWN_ITEMS: ChipDropdownItem[] = CLAUDE_MODEL_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label
}))

function labelForModel(value: string): string {
  if (!value) return 'Default'
  const known = CLAUDE_MODEL_OPTIONS.find((o) => o.value === value)
  return known ? known.label : value
}

interface ModelSelectChipProps {
  workspaceId: string
  icon: string | null
  /** The configured label from the footer action descriptor (e.g. "Model") —
   *  used as the dropdown title / tooltip prefix, NOT the chip face text. */
  label: string
  enabled?: boolean
}

export function ModelSelectChip({
  workspaceId,
  icon,
  label,
  enabled = true
}: ModelSelectChipProps): React.JSX.Element {
  const [modelValue, setModelValue] = useState<string>('')
  const [open, setOpen] = useState(false)
  const chipRef = useRef<HTMLDivElement>(null)
  const dropdownOverlayId = chipDropdownId(`model:${workspaceId}`)

  const refetchEffectiveModel = useCallback((): void => {
    window.api.workspaces
      .getEffectiveModel(workspaceId)
      .then((r) => setModelValue(r.model))
      .catch(() => {})
  }, [workspaceId])

  useEffect(() => {
    refetchEffectiveModel()
  }, [refetchEffectiveModel])

  const resolvedLabel = labelForModel(modelValue)

  const handleClick = useCallback((): void => {
    if (!chipRef.current) return
    if (open) {
      hideChipDropdown(dropdownOverlayId)
      return
    }
    const r = chipRef.current.getBoundingClientRect()
    setOpen(true)
    showChipDropdown(
      dropdownOverlayId,
      { x: r.left, y: r.top, w: r.width, h: r.height },
      { items: DROPDOWN_ITEMS, selectedValue: modelValue, title: label },
      workspaceId
    )
      .then((res) => {
        setOpen(false)
        if (!res) return // Cancel/Escape/outside-click/IPC failure

        // Update the chip face immediately — don't wait for a re-fetch round-trip.
        setModelValue(res.value)

        // Persist first (also suppresses the dirty flag), then inject live so
        // a no-op injection (claude busy, canInject false) still leaves the
        // setting saved.
        window.api.workspaces.setModel(workspaceId, res.value).catch(() => {})
        window.api.actions
          .invoke(
            {
              id: 'terminal.sendInput',
              params: { text: `/model ${res.value}`, submit: true },
              workspaceId
            },
            'footer'
          )
          .catch(() => {})
      })
      .catch((e) => console.error('[ModelSelectChip] dropdown failed', e))
  }, [open, dropdownOverlayId, modelValue, label, workspaceId])

  // Outside-click dismissal while the dropdown is open — mirrors ActionChip's
  // prompt-popover pattern: the popover lives in a separate child
  // BrowserWindow, so only clicks in the main window/terminal reach here.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (): void => {
      hideChipDropdown(dropdownOverlayId)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, dropdownOverlayId])

  const chipTitle = `${label}: ${resolvedLabel}`
  const isDisabled = enabled === false

  return (
    <div ref={chipRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={handleClick}
        title={chipTitle}
        aria-label={chipTitle}
        className={[
          'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs',
          'transition-colors duration-150',
          'border border-transparent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          isDisabled
            ? 'text-text-muted bg-surface-overlay/40'
            : open
              ? 'text-text-primary bg-surface-overlay border border-border-default/60'
              : [
                  'text-text-primary bg-surface-overlay/60',
                  'hover:bg-surface-overlay hover:border-border-default/60',
                  'active:scale-95 active:transition-transform active:duration-100'
                ].join(' ')
        ]
          .flat()
          .join(' ')}
      >
        <span className="flex-shrink-0 flex items-center" style={{ width: 12, height: 12 }}>
          {icon ? <IconByName name={icon} size={12} /> : null}
        </span>
        <span className="truncate max-w-[100px]">{resolvedLabel}</span>
        <IconByName name="CaretUp" size={9} className="flex-shrink-0 opacity-60" />
      </button>
    </div>
  )
}
