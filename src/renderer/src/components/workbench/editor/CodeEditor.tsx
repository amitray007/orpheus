// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/editor/CodeEditor.tsx
//
// The Files-tab EDITOR: a CodeMirror 6 editor that VISUALLY MATCHES Pierre's
// read-only <File> viewer. Three ingredients combine to hit that parity:
//   1. pierre-dark TOKEN colours via the vendored Shiki bridge
//      (./codemirror-shiki.ts + ./highlighter.ts) — same theme <File> uses.
//   2. pierre-dark CHROME (bg/cursor/selection/gutter/typography) via
//      ./chromeTheme.ts — the non-token surface Shiki doesn't cover.
//   3. Per-extension language support (./language.ts) for editing smarts.
//
// State the component owns:
//   - dirty: does the buffer differ from the last-saved baseline? Reported via
//     onDirtyChange and reflected as a header dot.
//   - save: Cmd/Ctrl+S writes via window.api.files.writeFile; on success the
//     baseline advances and dirty clears.
//   - auto-save: when `autoSave` is on, a 1s debounce writes on idle; manual
//     Cmd/Ctrl+S still works either way.
//
// The EditorView is created once per (workspaceId, path) mount. Highlighting is
// added asynchronously once the shared highlighter resolves (reconfigured in via
// a StateEffect/Compartment) so the editor is usable immediately and colours in
// a moment later — the same progressive-highlight behaviour Shiki-backed viewers
// have.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { pierreDarkChromeTheme } from './chromeTheme'
import { makeSearchPanel } from './searchPanel'
import { languageFor } from './language'
import { shikiHighlighting } from './codemirror-shiki'
import { getEditorHighlighter, EDITOR_THEME_NAME } from './highlighter'

const AUTO_SAVE_DEBOUNCE_MS = 1000

export interface CodeEditorProps {
  workspaceId: string
  /** Repo-relative POSIX path of the file being edited. */
  path: string
  /** Basename (for language inference + display). */
  name: string
  /** The file's contents at load time — the initial + first-baseline buffer. */
  initialContents: string
  /** When true, debounce-write on idle; when false, manual save only. */
  autoSave: boolean
  /** Reports dirty transitions up to FilesTab (drives the header dot). */
  onDirtyChange?: (dirty: boolean) => void
  /** Reports a successful save (e.g. to refresh any external view). */
  onSaved?: () => void
}

interface SaveState {
  /** The contents last successfully written (the dirty baseline). */
  baseline: string
  /** A write is in flight — coalesce concurrent saves. */
  saving: boolean
}

export function CodeEditor({
  workspaceId,
  path,
  name,
  initialContents,
  autoSave,
  onDirtyChange,
  onSaved
}: CodeEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveRef = useRef<SaveState>({ baseline: initialContents, saving: false })
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest autoSave flag, read inside the (stable) update listener without
  // re-creating the editor when the setting toggles. Synced in an effect (not
  // during render) so it doesn't trip the "no ref writes in render" rule.
  const autoSaveRef = useRef(autoSave)
  useEffect(() => {
    autoSaveRef.current = autoSave
  }, [autoSave])

  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Report dirty transitions up. Kept in a ref-free effect so parent re-renders
  // don't loop.
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // The actual write. Reads the current doc, writes it, and (on success)
  // advances the baseline + clears dirty. Coalesces concurrent calls.
  const doSave = useCallback(async (): Promise<void> => {
    const view = viewRef.current
    if (!view) return
    const contents = view.state.doc.toString()
    const state = saveRef.current
    if (state.saving || contents === state.baseline) return
    state.saving = true
    try {
      const result = await window.api.files.writeFile(workspaceId, path, contents)
      // Stale: a different file remounted this editor while the write was in
      // flight — don't let its completion mutate the new file's UI state.
      if (viewRef.current !== view) return
      if (result.ok) {
        state.baseline = contents
        setSaveError(null)
        // Only clear dirty if the buffer hasn't changed again mid-write.
        if (view.state.doc.toString() === contents) setDirty(false)
        onSaved?.()
      } else {
        setSaveError(saveErrorText(result.error))
      }
    } catch (e) {
      console.error('[CodeEditor] writeFile failed:', e)
      if (viewRef.current === view) setSaveError('Save failed')
    } finally {
      state.saving = false
    }
  }, [workspaceId, path, onSaved])

  // Keep a stable ref to doSave for the keymap + update listener (which are
  // baked into the editor state created once per mount). Synced in an effect so
  // the ref write doesn't happen during render.
  const doSaveRef = useRef(doSave)
  useEffect(() => {
    doSaveRef.current = doSave
  }, [doSave])

  // Create the editor once per (workspaceId, path). initialContents/name are
  // captured at creation; a different file remounts via the effect deps.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const { cm } = languageFor(name)
    const highlightCompartment = new Compartment()

    const updateListener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      const contents = update.state.doc.toString()
      const isDirty = contents !== saveRef.current.baseline
      setDirty(isDirty)
      if (isDirty && autoSaveRef.current) {
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = setTimeout(() => {
          void doSaveRef.current()
        }, AUTO_SAVE_DEBOUNCE_MS)
      }
    })

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          void doSaveRef.current()
          return true
        }
      }
    ])

    const state = EditorState.create({
      doc: initialContents,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        foldGutter(),
        indentOnInput(),
        bracketMatching(),
        // Find/Replace: a CUSTOM app-native panel pinned to the TOP of the
        // editor (createPanel → React root in EditorSearchPanel.tsx), replacing
        // @codemirror/search's default panel UI while keeping its engine.
        // searchKeymap still provides Cmd/Ctrl+F (open), Cmd/Ctrl+G / Shift+…
        // (next/prev match), and Esc (close).
        search({ top: true, createPanel: makeSearchPanel }),
        ...(cm ? [cm] : []),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        saveKeymap,
        updateListener,
        pierreDarkChromeTheme,
        highlightCompartment.of([]),
        EditorView.lineWrapping
      ]
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view

    // Reset per-mount baseline/dirty for the new file.
    saveRef.current = { baseline: initialContents, saving: false }
    setDirty(false)
    setSaveError(null)

    // Load highlighting asynchronously and reconfigure it in when ready.
    let cancelled = false
    const { shiki } = languageFor(name)
    getEditorHighlighter()
      .then((highlighter) => {
        if (cancelled || viewRef.current !== view) return
        view.dispatch({
          effects: highlightCompartment.reconfigure(
            shikiHighlighting({ highlighter, theme: EDITOR_THEME_NAME, lang: shiki })
          )
        })
      })
      .catch((e) => {
        console.error('[CodeEditor] highlighter load failed:', e)
      })

    return () => {
      cancelled = true
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
    // initialContents is intentionally captured at creation — a genuinely new
    // file arrives as a new `path`, which remounts. Editing must not reset the
    // doc from a stale prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, path, name])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 h-6 flex items-center gap-1.5 px-3 border-b border-border-default select-none">
        {dirty && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        )}
        <span className="text-[11px] text-text-secondary truncate">{name}</span>
        {saveError && <span className="ml-auto text-[10px] text-red-400">{saveError}</span>}
        {!saveError && (
          <span className="ml-auto text-[10px] text-text-muted">
            {autoSave ? 'Auto-save' : dirty ? '⌘S to save' : 'Saved'}
          </span>
        )}
      </div>
      <div ref={hostRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  )
}

function saveErrorText(error: 'traversal' | 'denied' | 'no-workspace'): string {
  if (error === 'traversal') return 'Refused: path outside workspace'
  if (error === 'no-workspace') return 'Workspace unavailable'
  return 'Save failed'
}
