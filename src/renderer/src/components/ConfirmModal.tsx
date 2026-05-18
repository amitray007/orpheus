import type React from 'react'
import { useEffect, useState } from 'react'
import { Button } from './Button'
import { playSound } from '../lib/sound'
import { useTerminalOverlay } from '../lib/overlayMode'

export interface ConfirmModalProps {
  title: string
  body: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: ConfirmModalProps): React.JSX.Element {
  const [loading, setLoading] = useState(false)

  // Flip ghostty's NSView behind the WebContents while this modal is on
  // screen so the dialog paints above the terminal pixels. Refcounted in
  // the OverlayModeProvider, so nested overlays nest cleanly.
  useTerminalOverlay()

  // Sound on mount
  useEffect(() => {
    playSound('modal-open')
  }, [])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        playSound('modal-close')
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function handleConfirm(): Promise<void> {
    if (loading) return
    setLoading(true)
    try {
      await onConfirm()
      playSound('success')
    } catch (err) {
      playSound('error')
      throw err
    } finally {
      setLoading(false)
    }
  }

  function handleBackdropMouseDown(): void {
    playSound('modal-close')
    onCancel()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="relative max-w-md w-full mx-4 bg-surface-overlay border border-border-default rounded-lg p-6 flex flex-col gap-4 pointer-events-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text-primary">{title}</h2>

        <div className="text-sm text-text-secondary">{body}</div>

        <div className="flex items-center gap-3">
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            size="md"
            loading={loading}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
          <button
            onClick={() => {
              playSound('modal-close')
              onCancel()
            }}
            className="text-sm text-text-secondary hover:text-text-primary transition-colors duration-150 cursor-pointer"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
