// Shared focus-target guard used by the sticky-terminal-focus logic (both the
// xterm surface and the WorkspaceView app-chrome refocus triggers). Returns true
// when the currently-focused element is a real text input the user is typing in,
// so auto-refocus never steals focus from rename fields, settings inputs, search
// boxes, etc. The xterm helper textarea is explicitly excluded (focusing it IS
// focusing the terminal).
export function isEditableTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  if (el instanceof HTMLTextAreaElement && el.classList.contains('xterm-helper-textarea'))
    return false
  if (el instanceof HTMLInputElement) {
    const type = (el.type || 'text').toLowerCase()
    return ['text', 'search', 'email', 'url', 'password', 'number', 'tel', ''].includes(type)
  }
  if (el instanceof HTMLTextAreaElement) return true
  if ((el as HTMLElement).contentEditable === 'true') return true
  return false
}
