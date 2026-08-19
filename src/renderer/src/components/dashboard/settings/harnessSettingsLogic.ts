// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/settings/harnessSettingsLogic.ts
//
// Pure logic for HarnessSection.tsx (U8, multi-harness architecture plan).
// Plain TypeScript — no React import — so both the component and
// scripts/verify-harness-settings-ui.ts can import and call the exact same
// functions (CLAUDE.md: "Assert behaviour, not source text... Extract the
// logic into a directly-callable pure function and call it").
// ---------------------------------------------------------------------------

import type {
  HarnessSettings,
  HarnessSettingRow,
  HarnessSettingsScope,
  CuratedFieldOptionsOverlay
} from '@shared/types'
import type { HarnessArgRow } from '@shared/harness/types'

// ---------------------------------------------------------------------------
// Secret-like env key detection (Part 4 / R7/KTD4)
// ---------------------------------------------------------------------------

// Case-insensitive match on any of these substrings anywhere in the key.
// Conservative-but-broad on purpose: a false positive just means an extra,
// harmless mask-by-default on a non-secret value (the user can still reveal
// it with one click); a false negative means a real secret (an API token, a
// password) is shown in PLAIN TEXT by default in a settings UI — a much
// worse failure mode. So the heuristic errs toward matching broadly across
// the whole "credential-shaped" family rather than trying to be precise.
const SECRET_KEY_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i

/** Returns true when an env-row key LOOKS secret-bearing (API keys, tokens,
 *  passwords, credentials, auth headers, ...) and should default to a masked
 *  display. Pure substring/regex heuristic — never inspects the row's value,
 *  only its key. Deliberately conservative-but-broad; see SECRET_KEY_PATTERN
 *  above for the reasoning. */
export function isSecretLikeKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key)
}

// ---------------------------------------------------------------------------
// Row reorder (Args/Env editor)
// ---------------------------------------------------------------------------

/** Moves the row at `index` one position up or down, returning a NEW array
 *  (never mutates `rows`). Moving the first row up, or the last row down, is
 *  a safe no-op that returns an equivalent (but still new) array rather than
 *  throwing or corrupting order — same for an out-of-range index. */
export function moveRow<T>(rows: readonly T[], index: number, direction: 'up' | 'down'): T[] {
  const next = [...rows]
  if (index < 0 || index >= next.length) return next
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= next.length) return next
  const tmp = next[index]
  next[index] = next[target]
  next[target] = tmp
  return next
}

/**
 * Moves the item at index `from` so it ends up at index `to` IN THE
 * RESULTING array — i.e. `to` is a post-move/"final index" coordinate, not
 * an index into the pre-move `rows`. This is the arbitrary-distance sibling
 * of `moveRow` (adjacent-swap only): drag-to-reorder needs to move item 8 to
 * position 1 in one call, not seven adjacent swaps.
 *
 * Implementation is the standard splice-out/splice-in, which already
 * satisfies the "final index" contract with no extra +/-1 adjustment: once
 * the source item is removed, every element originally after `from` shifts
 * left by one, so re-inserting at `to` (unadjusted) lands it at `to` in the
 * post-removal array — which IS the final array, since insertion is the last
 * step. Callers that derive `to` from an id/value lookup plus a before/after
 * drop position (see OrpheusFooterSection.tsx's onDrop) must resolve that to
 * a final index themselves before calling this — this function does not
 * re-derive it and does not know about drop position.
 *
 * Same no-op conventions as `moveRow`: returns a new array (never mutates
 * `rows`), and an out-of-range `from` or `to` (negative or >= length) is a
 * safe no-op that returns an equivalent copy rather than throwing.
 * `from === to` is also a no-op (splice-out-then-back-in at the same index
 * reproduces the original order, but this is short-circuited explicitly
 * rather than relied upon).
 */
export function moveRowTo<T>(rows: readonly T[], from: number, to: number): T[] {
  const next = [...rows]
  if (from < 0 || from >= next.length) return next
  if (to < 0 || to >= next.length) return next
  if (from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// ---------------------------------------------------------------------------
// Inherited-scope provenance
// ---------------------------------------------------------------------------

export const SCOPE_PRECEDENCE: readonly HarnessSettingsScope[] = ['global', 'project']

export interface HarnessScopeSettingsBundle {
  global: HarnessSettings
  project: HarnessSettings
}

export type CuratedFieldName = 'model' | 'effort'

export interface HarnessProvenance {
  /** key -> the FIRST (lowest-precedence) scope whose stored row for that key
   *  is present, regardless of `enabled` — provenance answers "where did
   *  this row come from", not "is it currently in effect". */
  args: Map<string, HarnessSettingsScope>
  env: Map<string, HarnessSettingsScope>
  curated: Partial<Record<CuratedFieldName, HarnessSettingsScope>>
}

function firstScopeForRows(
  rowsByScope: Array<[HarnessSettingsScope, HarnessSettingRow[] | undefined]>
): Map<string, HarnessSettingsScope> {
  const result = new Map<string, HarnessSettingsScope>()
  for (const [scope, rows] of rowsByScope) {
    if (!rows) continue
    for (const row of rows) {
      if (!result.has(row.key)) result.set(row.key, scope)
    }
  }
  return result
}

/** Resolves, per args/env key and per curated field, which scope (in
 *  global -> project -> workspace precedence order) FIRST introduced a
 *  value. Used by the Settings UI to show "inherited from <scope>" chips —
 *  see CliFlagsPreview in primitives.tsx for the muted-vs-normal-text
 *  visual precedent this drives. A key/field absent at every scope is
 *  simply absent from the returned maps/record (never a crash, never a
 *  placeholder scope). */
export function resolveProvenance(scopes: HarnessScopeSettingsBundle): HarnessProvenance {
  const byScope = SCOPE_PRECEDENCE.map(
    (scope) => [scope, scopes[scope]] as [HarnessSettingsScope, HarnessSettings]
  )

  const args = firstScopeForRows(byScope.map(([scope, s]) => [scope, s.args]))
  const env = firstScopeForRows(byScope.map(([scope, s]) => [scope, s.env]))

  const curated: Partial<Record<CuratedFieldName, HarnessSettingsScope>> = {}
  const curatedFields: CuratedFieldName[] = ['model', 'effort']
  for (const field of curatedFields) {
    for (const [scope, s] of byScope) {
      if (s.curated?.[field] !== undefined) {
        curated[field] = scope
        break
      }
    }
  }

  return { args, env, curated }
}

// ---------------------------------------------------------------------------
// Harness-provided default args merge
// ---------------------------------------------------------------------------

/** One row in the args editor, with provenance for display: `fromDefault`
 *  marks a row that currently matches a harness-provided default (whether
 *  or not the user has ever touched it) so the UI can render a
 *  harness-provided badge on it. */
export interface DefaultArgRowDraft extends HarnessSettingRow {
  fromDefault: boolean
}

/**
 * Merges a harness descriptor's `defaultArgs` with a user's stored rows for
 * the args editor at ONE scope, so a shipped default appears as a real,
 * editable, visibly-marked row rather than an invisible launch-time prefix.
 *
 * IDENTITY: matched by `key`. This is the same identity `resolveHarnessSettings`
 * (src/main/harness/settings.ts) already uses to merge args across scopes, so
 * "which row is this" means the same thing everywhere in the args pipeline —
 * a descriptor default and a user override are the same conceptual row
 * exactly when they share a flag name. The one case this doesn't fit is a
 * flag that legitimately repeats with different values (e.g. multiple
 * `--add-dir`) — but no default arg needs that today (CLAUDE_DEFAULT_ARGS is
 * a single `--permission-mode` row), and `key`-identity is what makes "the
 * user edited/disabled the default" and "the user added an unrelated row
 * with the same key" the same well-defined case rather than two.
 *
 * PRECEDENCE — never write a default into storage just for being displayed:
 *  - A default whose key is NOT in `userRows` is synthesized as a draft row
 *    (`fromDefault: true`) using the descriptor's own value/enabled — this
 *    row does not exist in storage yet. If the user never touches it, calling
 *    code must NOT persist it; onChange only fires from an explicit edit.
 *  - A default whose key IS in `userRows` (edited OR merely toggled — any
 *    user-authored row with that key) is rendered using the STORED row's
 *    value/enabled, not the descriptor's, and is still marked `fromDefault:
 *    true` (it still originated from a harness default, so the UI keeps
 *    showing where it came from) — so a later descriptor change can never
 *    clobber what the user set.
 *  - Any user row whose key matches no current default is passed through
 *    unmarked (`fromDefault: false`) — ordinary user-authored rows, and also
 *    what a REMOVED descriptor default becomes (inert data, never deleted).
 *
 * ORDER: defaults first (in descriptor order), then the user's own
 * non-default rows in their stored order — matches the existing args-editor
 * convention (baseline rows before ad hoc additions) and keeps order stable
 * across re-renders regardless of where in `userRows` an edited default
 * happens to sit.
 */
export function mergeDefaultArgs(
  defaultArgs: readonly HarnessArgRow[] | undefined,
  userRows: readonly HarnessSettingRow[] | undefined
): DefaultArgRowDraft[] {
  const defaults = defaultArgs ?? []
  const rows = userRows ?? []
  const userByKey = new Map(rows.map((row) => [row.key, row]))
  const defaultKeys = new Set(defaults.map((d) => d.key))

  const merged: DefaultArgRowDraft[] = defaults.map((def) => {
    const userRow = userByKey.get(def.key)
    return userRow
      ? { ...userRow, fromDefault: true }
      : { key: def.key, value: def.value, enabled: def.enabled, fromDefault: true }
  })

  for (const row of rows) {
    if (!defaultKeys.has(row.key)) merged.push({ ...row, fromDefault: false })
  }

  return merged
}

/**
 * Inverse of the display-time merge: given the args editor's current rows
 * (post-edit, as emitted by the row editor's onChange — plain
 * key/value/enabled, no display-only provenance) and the harness's
 * defaults, returns exactly what should be PERSISTED to
 * `HarnessSettings.args` — the untouched-default half of
 * `mergeDefaultArgs`'s contract enforced on the write path.
 *
 * A row is written to storage only when it differs from the descriptor
 * default sharing its key (or isn't a default at all). A row that's still
 * value-for-value identical to its descriptor default is dropped rather
 * than round-tripped into storage, so a user who never touched a default
 * keeps writing `{}`/no row for it, and a future change to the descriptor's
 * own default still reaches them. Takes plain HarnessSettingRow[] (not
 * DefaultArgRowDraft[]) deliberately — this runs on the editor's onChange
 * output, which has already dropped the display-only `fromDefault`/`id`
 * fields; re-deriving "is this a default" from `key` against `defaultArgs`
 * here is the single source of truth, not a flag threaded through the UI.
 */
export function draftsToStoredRows(
  rows: readonly HarnessSettingRow[],
  defaultArgs: readonly HarnessArgRow[] | undefined
): HarnessSettingRow[] {
  const defaultByKey = new Map((defaultArgs ?? []).map((d) => [d.key, d]))
  const result: HarnessSettingRow[] = []
  for (const row of rows) {
    const def = defaultByKey.get(row.key)
    const matchesDefault = def && def.value === row.value && def.enabled === row.enabled
    if (matchesDefault) continue
    result.push(row)
  }
  return result
}

// ---------------------------------------------------------------------------
// Unsaved-changes detection (explicit Save)
// ---------------------------------------------------------------------------

/**
 * Does `draftRows` hold changes not yet reflected in `loadedRows` (the rows
 * last loaded from — or saved to — storage)?
 *
 * This replaces a render-time resync guard (`shouldResyncDrafts`, now
 * deleted) that auto-saved on blur and fought local edits: three bugs in a
 * row (a dead Add button, a React #301 crash, typed text disappearing
 * mid-edit) all traced back to that architecture. The fix is explicit save —
 * local drafts are the single source of truth while editing, seeded from
 * props once and re-seeded only on a deliberate context change (switching
 * harness or scope), never in response to this check. This function only
 * answers "is there anything to save"; it never triggers a resync itself.
 *
 * BLANK ROWS ARE NOT CHANGES. A row with an empty key is a pending,
 * deliberately uncommitted addition (see `addRow` in HarnessSection.tsx) —
 * it must not make an otherwise-untouched draft list read as dirty, and it
 * must never be persisted (callers filter it out at save time; see
 * `draftsToStoredRows` and the `key.trim() === ''` filter in
 * `HarnessSection`'s `save()`). Filtering both sides identically also keeps
 * the comparison symmetric: a blank row that somehow reached storage cannot
 * make an otherwise-clean draft list read as dirty either.
 */
export function hasUnsavedChanges(
  loadedRows: readonly { key: string; value?: string; enabled: boolean; fromDefault?: boolean }[],
  draftRows: readonly { key: string; value?: string; enabled: boolean; fromDefault?: boolean }[]
): boolean {
  const project = (r: {
    key: string
    value?: string
    enabled: boolean
    fromDefault?: boolean
  }): string => JSON.stringify({ k: r.key, v: r.value, e: r.enabled, d: r.fromDefault })
  const loaded = loadedRows
    .filter((r) => r.key.trim() !== '')
    .map(project)
    .join(' ')
  const draft = draftRows
    .filter((r) => r.key.trim() !== '')
    .map(project)
    .join(' ')
  return loaded !== draft
}

// ---------------------------------------------------------------------------
// Launch preview (B2 restructure — collapsible Launch panel)
// ---------------------------------------------------------------------------

/**
 * Assembles the live "claude <flags>" command line the Launch panel shows —
 * binary followed by every currently-ENABLED arg row, in editor order,
 * key then value (value omitted when blank). Pure string assembly over
 * whatever rows are passed in, same convention as HarnessSection's own
 * (picker-only) harnessCommandPreview — this is the general form of that,
 * usable against live draft rows (which may include harness defaults,
 * user overrides, and in-progress edits) rather than only a harness's
 * shipped defaults. A blank-key row (in-progress Add) is skipped, matching
 * hasUnsavedChanges/draftsToStoredRows's "blank rows aren't real" contract.
 */
export function composedCommandPreview(
  binary: string,
  argRows: readonly { key: string; value?: string; enabled: boolean }[]
): string {
  const tokens: string[] = [binary]
  for (const row of argRows) {
    if (!row.enabled) continue
    if (row.key.trim() === '') continue
    tokens.push(row.key)
    if (row.value) tokens.push(row.value)
  }
  return tokens.join(' ')
}

// ---------------------------------------------------------------------------
// Section summary lines (B2 restructure — collapsible section headers)
// ---------------------------------------------------------------------------

/** "N enabled, M default" — the Arguments section's populated summary line.
 *  `total` counts every row (blank in-progress rows excluded); `enabled`
 *  counts rows with `enabled: true`; `fromDefault` counts rows currently
 *  matching a harness-provided default (see mergeDefaultArgs). Returns
 *  "No arguments" when there are none, so the summary line is never blank. */
export function summarizeArgRows(
  rows: readonly { key: string; enabled: boolean; fromDefault?: boolean }[]
): string {
  const named = rows.filter((r) => r.key.trim() !== '')
  if (named.length === 0) return 'No arguments'
  const enabledCount = named.filter((r) => r.enabled).length
  const defaultCount = named.filter((r) => r.fromDefault).length
  const parts = [`${enabledCount} enabled`]
  if (defaultCount > 0) parts.push(`${defaultCount} default`)
  return parts.join(', ')
}

/** "N variables" (or "No variables") — the Environment section's summary
 *  line. Counts only named (non-blank-key) rows, matching summarizeArgRows'
 *  and hasUnsavedChanges' "blank rows aren't real" convention. */
export function summarizeEnvRows(rows: readonly { key: string }[]): string {
  const count = rows.filter((r) => r.key.trim() !== '').length
  if (count === 0) return 'No variables'
  return `${count} variable${count === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// Models/Effort option-list editors (B3, support-multi-harness)
// ---------------------------------------------------------------------------
//
// The Models/Effort sections edit HarnessSettings.curatedOptions — a
// per-field {add,hide,order} OVERLAY onto a descriptor's shipped `options`
// (see CuratedFieldOptionsOverlay's doc comment in src/main/harness/settings.ts
// and src/shared/harness/curatedOptions.ts's resolver for the full
// rationale). The editor works over a DRAFT ROW LIST — the resolved,
// ordered option set with per-row hidden/custom flags — the same
// "draft rows are the single source of truth while editing, converted to
// storage shape only at Save" pattern draftsToStoredRows/mergeDefaultArgs
// already establish for the Arguments editor above.

/** One row in the Models/Effort editor: a resolved option value plus
 *  display-only provenance (`custom`: not in the descriptor's own list, so
 *  the UI can render the non-blocking warning chip) and editable state
 *  (`hidden`). Order in the array IS the order — no separate index field,
 *  matching HarnessRowEditor's args/env row convention of "array order is
 *  the persisted order". */
export interface CuratedOptionRowDraft {
  value: string
  /** True when `value` is not present in the descriptor's own `options` —
   *  i.e. it only exists because of `overlay.add` (or, for the currently
   *  selected value, because resolveCuratedOptions reinstated it after a
   *  hide). Purely informational for the warning chip; never blocks saving
   *  or editing, matching CuratedField.allowCustom's "never validates
   *  against options" contract. */
  custom: boolean
  hidden: boolean
  /** True when `value` is the field's current selection (HarnessCuratedSettings
   *  .model/.effort). A hidden-but-selected row must still render — see
   *  resolveCuratedOptions — and the editor marks it so the UI can explain
   *  why a "hidden" row is still visible instead of leaving that
   *  unexplained. */
  selected: boolean
}

/**
 * Builds the Models/Effort editor's draft rows.
 *
 * DELIBERATELY DOES NOT CALL resolveCuratedOptions for the row set itself —
 * that function's whole job is to produce the PICKER's list, which correctly
 * DROPS a hidden-and-unselected value entirely (nothing to show a user
 * choosing a model). The Settings EDITOR needs the opposite: hidden rows
 * must still be listed (with their toggle showing "off") so the user has
 * something to flip back on — "hide beats delete, reversible" only holds if
 * there's a visible switch to reverse it with. So this builds the editor's
 * row set from `descriptorOptions` + `overlay.add` directly (every value the
 * overlay could possibly be talking about), independent of hide, then
 * annotates each with hidden/custom/selected and applies `order` for
 * display — the same three concerns resolveCuratedOptions applies, just
 * without ever discarding a row over `hide`.
 *
 * `custom` is derived from `descriptorOptions`, NOT from `overlay.add` —
 * kept consistent with the resolver's own convention (a value can be
 * "custom" without being in `add`, e.g. a legacy selection from a
 * since-changed descriptor that this function also folds in via
 * `selectedValue`, mirroring resolveCuratedOptions' own reinstatement path).
 */
export function buildCuratedOptionRows(
  descriptorOptions: readonly string[],
  overlay: CuratedFieldOptionsOverlay | undefined,
  selectedValue: string | undefined
): CuratedOptionRowDraft[] {
  const descriptorSet = new Set(descriptorOptions)
  const hideSet = new Set(overlay?.hide ?? [])

  // Every value the editor must be able to show: descriptor options, plus
  // whatever the overlay's `add` introduced, plus (mirroring
  // resolveCuratedOptions' own reinstatement) the current selection even if
  // it belongs to neither set — a legacy value must still get a row to
  // display, not just survive invisibly.
  const working = [...descriptorOptions]
  const seen = new Set(working)
  for (const value of overlay?.add ?? []) {
    if (seen.has(value)) continue
    working.push(value)
    seen.add(value)
  }
  if (selectedValue && !seen.has(selectedValue)) {
    working.push(selectedValue)
    seen.add(selectedValue)
  }

  // Apply `order` for DISPLAY ordering only — never as a filter. Same
  // "named first, then the rest in relative order, unknown names ignored"
  // rule as resolveCuratedOptions' own order step.
  const order = overlay?.order ?? []
  let ordered = working
  if (order.length > 0) {
    const remaining = new Set(working)
    const front: string[] = []
    for (const value of order) {
      if (!remaining.has(value)) continue
      front.push(value)
      remaining.delete(value)
    }
    ordered = [...front, ...working.filter((value) => remaining.has(value))]
  }

  return ordered.map((value) => ({
    value,
    custom: !descriptorSet.has(value),
    hidden: hideSet.has(value),
    selected: value === selectedValue
  }))
}

/**
 * Inverse of buildCuratedOptionRows: given the editor's current draft rows
 * (post add/hide-toggle/reorder) and the descriptor's own `options`, derives
 * exactly what should be PERSISTED as this field's CuratedFieldOptionsOverlay.
 *
 *  - `add`: every draft row's value not present in `descriptorOptions` —
 *    i.e. every `custom` row, regardless of the `custom` flag on the row
 *    object itself (which is display-only and re-derived here, not trusted
 *    — same discipline as draftsToStoredRows re-deriving "is this a
 *    default" from `key` rather than trusting a threaded-through flag).
 *  - `hide`: every draft row currently marked hidden.
 *  - `order`: the full draft row order, VALUES ONLY — always written
 *    (never omitted) whenever any row exists, because order is a property
 *    of the whole list and there is no "default" order to fall back to
 *    once the user has touched this editor at all; a partial order would
 *    be ambiguous with "no opinion" per resolveCuratedOptions' semantics.
 *
 * An empty `rows` array (nothing left after removing every custom addition,
 * theoretically) or a draft that produces an all-empty overlay collapses to
 * `undefined` rather than persisting `{}` — matching mergeCuratedOptions'
 * per-field-absence convention: an empty overlay object is NOT the same as
 * "no opinion" once merged across scopes (an empty {} would still win over
 * an earlier scope's real overlay), so this must not manufacture one.
 */
export function draftRowsToOverlay(
  rows: readonly CuratedOptionRowDraft[],
  descriptorOptions: readonly string[]
): CuratedFieldOptionsOverlay | undefined {
  if (rows.length === 0) return undefined

  const descriptorSet = new Set(descriptorOptions)
  const add = rows.filter((r) => !descriptorSet.has(r.value)).map((r) => r.value)
  const hide = rows.filter((r) => r.hidden).map((r) => r.value)
  const order = rows.map((r) => r.value)

  const overlay: CuratedFieldOptionsOverlay = {}
  if (add.length > 0) overlay.add = add
  if (hide.length > 0) overlay.hide = hide
  if (order.length > 0) overlay.order = order

  return Object.keys(overlay).length > 0 ? overlay : undefined
}

/**
 * Does `draftRows` differ from `loadedRows` (the rows last loaded from — or
 * saved to — storage)? Compares value/hidden/order (position in the array
 * IS the order, so array index participates in the comparison via JSON
 * stringification of the whole sequence) — `custom`/`selected` are
 * display-only derivations and deliberately excluded, so a value merely
 * changing custom/selected status (e.g. because the user picked a different
 * model elsewhere) never reads as an unsaved change in THIS editor.
 */
export function curatedOptionsRowsDirty(
  loadedRows: readonly CuratedOptionRowDraft[],
  draftRows: readonly CuratedOptionRowDraft[]
): boolean {
  const project = (r: CuratedOptionRowDraft): string => JSON.stringify({ v: r.value, h: r.hidden })
  return loadedRows.map(project).join(' ') !== draftRows.map(project).join(' ')
}

/** "N shown, M hidden" (or "Default list") — the Models/Effort sections'
 *  populated summary line, same "never blank" convention as
 *  summarizeArgRows/summarizeEnvRows. "Default list" specifically means
 *  every row is unmodified descriptor output with nothing hidden and
 *  nothing custom — not merely "hidden count is zero" — so a user who only
 *  reordered rows (still descriptor-only, still nothing hidden) sees that
 *  reflected rather than a misleading "Default list". */
export function summarizeCuratedOptionRows(rows: readonly CuratedOptionRowDraft[]): string {
  if (rows.length === 0) return 'Default list'
  const hiddenCount = rows.filter((r) => r.hidden).length
  const shownCount = rows.length - hiddenCount
  const customCount = rows.filter((r) => r.custom).length
  if (hiddenCount === 0 && customCount === 0) return 'Default list'
  const parts = [`${shownCount} shown`]
  if (hiddenCount > 0) parts.push(`${hiddenCount} hidden`)
  return parts.join(', ')
}
