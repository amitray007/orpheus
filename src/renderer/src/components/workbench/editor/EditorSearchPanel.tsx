// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/editor/EditorSearchPanel.tsx
//
// The CUSTOM, app-native find/replace panel for the Files-tab CodeEditor —
// replaces @codemirror/search's default (ugly, browser-default-styled) panel
// while keeping CM's search ENGINE. We provide `search({ createPanel })`; the
// factory (`makeSearchPanel`) returns a CM `Panel` whose `dom` hosts a React
// root rendering <EditorSearchPanel view={view} />. We drive CM by dispatching
// `setSearchQuery` (updates the query + re-highlights matches) and calling the
// exported commands (`findNext`/`findPrevious`/`replaceNext`/`replaceAll`/
// `closeSearchPanel`). Match count ("3/12") is computed with the query's own
// cursor, capped for huge docs.
//
// Lifecycle: CM calls `mount()` after inserting `dom`, and `destroy()` when the
// panel closes or the editor tears down — we unmount the React root there, so
// there is no leak and no double-mount on reopen (each open makes a fresh
// Panel + root). `update(viewUpdate)` re-renders so the count/inputs track the
// live doc, selection, and search state.
//
// The editor is pierre-dark (independent of the app accent), so the panel
// paints itself from `searchPanelPalette` (sourced from the same pierre-dark
// colours as the editor chrome) rather than the app's gold accent tokens —
// this keeps it visually one piece with the dark editor.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { EditorView } from '@codemirror/view'
import {
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  closeSearchPanel
} from '@codemirror/search'
import {
  MagnifyingGlass,
  CaretUp,
  CaretDown,
  X,
  TextAa,
  Asterisk,
  TextT
} from '@phosphor-icons/react'
import { searchPanelPalette as C } from './chromeTheme'

// Cap match counting on very large docs so we never scan the whole buffer on
// every keystroke — past this we show "N+" instead of a precise total.
const MATCH_COUNT_CAP = 1000

// ---------------------------------------------------------------------------
// Match counting — walk the query's own cursor to derive (current, total).
// Extracted so the component body stays flat.
// ---------------------------------------------------------------------------

interface MatchInfo {
  /** 1-based index of the current match, or 0 when the selection isn't on one. */
  current: number
  /** Total matches, capped at MATCH_COUNT_CAP. */
  total: number
  /** True when `total` hit the cap (render as "N+"). */
  capped: boolean
}

function computeMatchInfo(view: EditorView): MatchInfo {
  const query = getSearchQuery(view.state)
  if (!query.valid) return { current: 0, total: 0, capped: false }

  const { from: selFrom, to: selTo } = view.state.selection.main
  const cursor = query.getCursor(view.state)
  let total = 0
  let current = 0
  let capped = false

  let step = cursor.next()
  while (!step.done) {
    total += 1
    const { from, to } = step.value
    if (current === 0 && from === selFrom && to === selTo) current = total
    if (total >= MATCH_COUNT_CAP) {
      capped = true
      break
    }
    step = cursor.next()
  }
  return { current, total, capped }
}

function formatCount({ current, total, capped }: MatchInfo): string {
  if (total === 0) return 'No results'
  const totalLabel = capped ? `${total}+` : String(total)
  return current > 0 ? `${current}/${totalLabel}` : `${totalLabel} found`
}

// ---------------------------------------------------------------------------
// Query dispatch — build a SearchQuery from the current inputs/toggles and push
// it into CM (which re-highlights). Extracted from the component.
// ---------------------------------------------------------------------------

interface QueryFields {
  search: string
  replace: string
  caseSensitive: boolean
  regexp: boolean
  wholeWord: boolean
}

function dispatchQuery(view: EditorView, fields: QueryFields): void {
  view.dispatch({
    effects: setSearchQuery.of(
      new SearchQuery({
        search: fields.search,
        replace: fields.replace,
        caseSensitive: fields.caseSensitive,
        regexp: fields.regexp,
        wholeWord: fields.wholeWord
      })
    )
  })
}

// ---------------------------------------------------------------------------
// Small styled primitives (inline styles so the panel matches pierre-dark
// without depending on the app's accent tokens).
// ---------------------------------------------------------------------------

const focusHandlers = {
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = C.accent
  },
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = C.border
  }
}

function iconButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    flexShrink: 0,
    borderRadius: 4,
    border: `1px solid ${active ? C.accent : 'transparent'}`,
    backgroundColor: active ? C.accentSoft : 'transparent',
    color: active ? C.accent : C.muted,
    cursor: 'pointer',
    padding: 0
  }
}

/** An icon TOGGLE button (Match Case / Regexp / Whole Word) — accent fill when
 *  on, quiet when off. Not a native checkbox. */
function ToggleButton({
  active,
  onToggle,
  label,
  children
}: {
  active: boolean
  onToggle: () => void
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const style = iconButtonStyle(active)
  if (hover && !active) {
    style.backgroundColor = C.buttonHoverBg
    style.color = C.fg
  }
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onToggle}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    >
      {children}
    </button>
  )
}

/** A plain icon action button (prev / next / close). */
function ActionButton({
  onClick,
  label,
  children
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const style = iconButtonStyle(false)
  if (hover) {
    style.backgroundColor = C.buttonHoverBg
    style.color = C.fg
  }
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    >
      {children}
    </button>
  )
}

/** A small text action button (Replace / Replace all). */
function TextButton({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 24,
        padding: '0 8px',
        flexShrink: 0,
        borderRadius: 4,
        border: `1px solid ${C.border}`,
        backgroundColor: hover ? C.buttonHoverBg : C.buttonBg,
        color: C.fg,
        fontSize: 11,
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      }}
    >
      {children}
    </button>
  )
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 24,
  padding: '0 8px',
  borderRadius: 4,
  border: `1px solid ${C.border}`,
  backgroundColor: C.inputBg,
  color: C.fg,
  caretColor: C.accent,
  fontFamily: C.fontFamily,
  fontSize: 12,
  outline: 'none'
}

// ---------------------------------------------------------------------------
// The panel component.
// ---------------------------------------------------------------------------

/** Seed the find/replace inputs AND toggles from any query CM already holds
 *  (so reopening — or opening with a selection CM prefilled — keeps the last
 *  query, flags included). */
function initialFields(view: EditorView): QueryFields {
  const q = getSearchQuery(view.state)
  return {
    search: q.search,
    replace: q.replace,
    caseSensitive: q.caseSensitive,
    regexp: q.regexp,
    wholeWord: q.wholeWord
  }
}

export function EditorSearchPanel({
  view,
  subscribe
}: {
  view: EditorView
  /** Register a callback fired on each CM view update (so count re-renders). */
  subscribe: (cb: () => void) => () => void
}): React.JSX.Element {
  const [seed] = useState(() => initialFields(view))
  const [search, setSearch] = useState(seed.search)
  const [replace, setReplace] = useState(seed.replace)
  const [caseSensitive, setCaseSensitive] = useState(seed.caseSensitive)
  const [regexp, setRegexp] = useState(seed.regexp)
  const [wholeWord, setWholeWord] = useState(seed.wholeWord)
  const [, forceRerender] = useState(0)
  const findInputRef = useRef<HTMLInputElement | null>(null)

  // Re-render on CM updates so the match count tracks doc/selection changes.
  useEffect(() => subscribe(() => forceRerender((n) => n + 1)), [subscribe])

  // Autofocus the find input on open, selecting any seeded text.
  useEffect(() => {
    const el = findInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const pushQuery = useCallback(
    (next: Partial<QueryFields>) => {
      dispatchQuery(view, {
        search,
        replace,
        caseSensitive,
        regexp,
        wholeWord,
        ...next
      })
    },
    [view, search, replace, caseSensitive, regexp, wholeWord]
  )

  const onSearchChange = useCallback(
    (value: string) => {
      setSearch(value)
      pushQuery({ search: value })
    },
    [pushQuery]
  )

  const onReplaceChange = useCallback(
    (value: string) => {
      setReplace(value)
      pushQuery({ replace: value })
    },
    [pushQuery]
  )

  const toggle = useCallback(
    (key: 'caseSensitive' | 'regexp' | 'wholeWord') => {
      const setter = {
        caseSensitive: setCaseSensitive,
        regexp: setRegexp,
        wholeWord: setWholeWord
      }[key]
      const nextVal = !{ caseSensitive, regexp, wholeWord }[key]
      setter(nextVal)
      pushQuery({ [key]: nextVal })
    },
    [pushQuery, caseSensitive, regexp, wholeWord]
  )

  const onFindKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) findPrevious(view)
        else findNext(view)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeSearchPanel(view)
      }
    },
    [view]
  )

  const onReplaceKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        replaceNext(view)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeSearchPanel(view)
      }
    },
    [view]
  )

  const countLabel = search ? formatCount(computeMatchInfo(view)) : ''

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 8px',
        fontFamily: C.fontFamily
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Row 1 — find */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          <MagnifyingGlass
            size={13}
            style={{
              position: 'absolute',
              left: 7,
              top: '50%',
              transform: 'translateY(-50%)',
              color: C.muted,
              pointerEvents: 'none'
            }}
          />
          <input
            ref={findInputRef}
            type="text"
            placeholder="Find"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onFindKeyDown}
            {...focusHandlers}
            style={{ ...inputStyle, paddingLeft: 24, paddingRight: 64 }}
          />
          <span
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              color: C.muted,
              fontSize: 11,
              pointerEvents: 'none',
              whiteSpace: 'nowrap'
            }}
          >
            {countLabel}
          </span>
        </div>
        <ToggleButton
          active={caseSensitive}
          onToggle={() => toggle('caseSensitive')}
          label="Match case"
        >
          <TextAa size={15} />
        </ToggleButton>
        <ToggleButton active={wholeWord} onToggle={() => toggle('wholeWord')} label="Whole word">
          <TextT size={15} />
        </ToggleButton>
        <ToggleButton active={regexp} onToggle={() => toggle('regexp')} label="Regular expression">
          <Asterisk size={15} />
        </ToggleButton>
        <ActionButton onClick={() => findPrevious(view)} label="Previous match">
          <CaretUp size={15} />
        </ActionButton>
        <ActionButton onClick={() => findNext(view)} label="Next match">
          <CaretDown size={15} />
        </ActionButton>
        <ActionButton onClick={() => closeSearchPanel(view)} label="Close">
          <X size={15} />
        </ActionButton>
      </div>
      {/* Row 2 — replace */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input
          type="text"
          placeholder="Replace"
          value={replace}
          onChange={(e) => onReplaceChange(e.target.value)}
          onKeyDown={onReplaceKeyDown}
          {...focusHandlers}
          style={{ ...inputStyle, paddingLeft: 8 }}
        />
        <TextButton onClick={() => replaceNext(view)}>Replace</TextButton>
        <TextButton onClick={() => replaceAll(view)}>All</TextButton>
      </div>
    </div>
  )
}
