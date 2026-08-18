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

export const SCOPE_PRECEDENCE: readonly HarnessSettingsScope[] = ['global', 'project', 'workspace']

export interface HarnessScopeSettingsBundle {
  global: HarnessSettings
  project: HarnessSettings
  workspace: HarnessSettings
}

export type CuratedFieldName = 'model' | 'effort' | 'permissionMode'

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
  const curatedFields: CuratedFieldName[] = ['model', 'effort', 'permissionMode']
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
