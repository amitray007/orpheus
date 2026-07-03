import { useCallback, useState } from 'react'

export interface UseInlineRenameResult {
  /** Current (possibly-edited) value of the rename input. */
  value: string
  /** Wire directly to the input's onChange (pass `e.target.value`). */
  setValue: (v: string) => void
  /** Reseed the input from an arbitrary string — call when rename mode begins, so
   *  the input starts from whatever the user currently sees (not always `currentName`). */
  seed: (v: string) => void
  /**
   * Trims `value`; if non-empty and different from `currentName`, calls
   * `onCommit(trimmed)`. Always resets `value` back to `currentName` afterward
   * (so a future rename starts clean) — this matches the strictest of the
   * duplicated call sites (Sidebar's WorkspaceSubRow); sites that didn't reset
   * previously are unaffected in observable behavior because they always
   * re-seed via `seed()`/`beginRename` before the input is shown again.
   */
  commit: () => void
  /** Resets `value` back to `currentName` without calling `onCommit`. */
  cancel: () => void
}

/**
 * Shared value-state + commit/cancel/trim protocol for inline rename inputs
 * (Sidebar workspace/project rows, WorkspacesTab's workspace name cell). The
 * caller still owns *whether* rename mode is active (each site's "which row
 * is being renamed" state differs structurally) — this hook only owns the
 * text value and the trim/no-op/commit decision.
 */
export function useInlineRename(
  currentName: string,
  onCommit: (trimmed: string) => void
): UseInlineRenameResult {
  const [value, setValue] = useState(currentName)

  const seed = useCallback((v: string): void => {
    setValue(v)
  }, [])

  const commit = useCallback((): void => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== currentName) {
      onCommit(trimmed)
    }
    setValue(currentName)
  }, [value, currentName, onCommit])

  const cancel = useCallback((): void => {
    setValue(currentName)
  }, [currentName])

  return { value, setValue, seed, commit, cancel }
}
