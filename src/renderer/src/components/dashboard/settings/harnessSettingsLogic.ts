// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/settings/harnessSettingsLogic.ts
//
// Pure logic for HarnessSection.tsx (U8, multi-harness architecture plan).
// Plain TypeScript — no React import — so both the component and
// scripts/verify-harness-settings-ui.ts can import and call the exact same
// functions (CLAUDE.md: "Assert behaviour, not source text... Extract the
// logic into a directly-callable pure function and call it").
// ---------------------------------------------------------------------------

import type { HarnessSettings, HarnessSettingRow, HarnessSettingsScope } from '@shared/types'
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
// Row enable toggle
// ---------------------------------------------------------------------------

/** Returns a new array with the row at `index` having its `enabled` flag
 *  flipped to `enabled`. Extracted (rather than an inline `rows.map(...)`
 *  at each call site) purely so the reorder/toggle/provenance trio all live
 *  in one pure, independently testable module. */
export function setRowEnabled<T extends { enabled: boolean }>(
  rows: readonly T[],
  index: number,
  enabled: boolean
): T[] {
  return rows.map((row, i) => (i === index ? { ...row, enabled } : row))
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
// Editor resync
// ---------------------------------------------------------------------------

/**
 * Should the row editor discard its local drafts and resync from the props?
 *
 * True only when the EXTERNAL rows genuinely differ from the drafts the user
 * has actually named. Drafts with a blank key are PENDING — `addRow` creates
 * one deliberately uncommitted, because a row with no key is not a setting
 * yet and persisting it would write an empty flag.
 *
 * The subtlety this function exists to pin: comparing the raw lists counts a
 * pending row as divergence, so the guard fires on the very next render and
 * deletes the new row before the user can type in it. The row appears and
 * vanishes within a frame, which reads as "the Add button does nothing".
 *
 * A real external change (a different scope loaded, a default toggled) still
 * returns true and still discards the pending row — correct, since it held
 * nothing.
 */
export function shouldResyncDrafts(
  externalRows: readonly { key: string; value?: string; enabled: boolean; fromDefault?: boolean }[],
  drafts: readonly { key: string; value?: string; enabled: boolean; fromDefault?: boolean }[]
): boolean {
  const project = (r: {
    key: string
    value?: string
    enabled: boolean
    fromDefault?: boolean
  }): string => JSON.stringify({ k: r.key, v: r.value, e: r.enabled, d: r.fromDefault })
  const external = externalRows.map(project).join('\u0000')
  const local = drafts
    .filter((d) => d.key.trim() !== '')
    .map(project)
    .join('\u0000')
  return external !== local
}
