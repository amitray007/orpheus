// ---------------------------------------------------------------------------
// src/shared/harness/curatedOptions.ts
//
// Pure resolver for a curated field's (model/effort) OPTION LIST — the
// picker's suggestion list, not the currently-selected value — after
// applying a user's CuratedFieldOptionsOverlay (B3, support-multi-harness;
// see HarnessCuratedOptionsSettings's doc comment in
// src/main/harness/settings.ts for the full storage-shape rationale).
//
// Lives in src/shared (not src/main) so BOTH the renderer (the Models/Effort
// settings editors, and eventually B4's footer pickers) and main-process
// verification can import the exact same function — check:arch forbids
// src/renderer -> src/main, matching liveApply.ts's precedent in this same
// directory. Pure and side-effect-free: takes plain data in, returns a plain
// array out, no IPC/DOM dependency.
// ---------------------------------------------------------------------------

import type { CuratedFieldOptionsOverlay } from '../types'

/**
 * Resolves a curated field's final, ordered option list: start from the
 * descriptor's shipped `descriptorOptions`, layer the user's `overlay` on
 * top, and make sure `selectedValue` — if given — is never silently dropped
 * even if the user hid it.
 *
 * Steps, in order:
 *  1. ADD — append `overlay.add` entries not already present in
 *     `descriptorOptions` (dedupe; an `add` entry that duplicates a
 *     descriptor option is a no-op, not a second copy).
 *  2. HIDE — remove `overlay.hide` entries from the working set, EXCEPT
 *     `selectedValue`. This is the single most important rule here: a
 *     hidden-but-currently-selected value must still appear in the
 *     resolved list, or the user has no way to see what they're actually
 *     running (the picker would show a blank/unknown selection for a value
 *     that is, in fact, active). Hiding is a preference about what to
 *     OFFER going forward, never a way to make an active selection
 *     disappear.
 *  3. ORDER — entries named in `overlay.order` come first, in the order
 *     given; everything else keeps its relative position after them. An
 *     `order` entry naming a value no longer in the working set (removed by
 *     `hide`, or never existed) is silently skipped rather than throwing —
 *     order is advisory over whatever the final set turns out to be.
 *
 * Total function: an undefined or entirely-empty `overlay` returns
 * `descriptorOptions` BY REFERENCE (not a copy) — a true no-op, matching
 * mergeCuratedModelEffort's convention in src/main/db/data-steps.ts of
 * returning the same object when nothing changed, so callers can use
 * reference equality as a cheap "did anything change" check if they want
 * to.
 */
export function resolveCuratedOptions(
  descriptorOptions: readonly string[],
  overlay: CuratedFieldOptionsOverlay | undefined,
  selectedValue?: string
): string[] {
  if (!overlay || (!overlay.add?.length && !overlay.hide?.length && !overlay.order?.length)) {
    return descriptorOptions as string[]
  }

  // 1. ADD — append new entries, deduped against what's already present.
  const withAdds = [...descriptorOptions]
  const seen = new Set(withAdds)
  for (const value of overlay.add ?? []) {
    if (seen.has(value)) continue
    withAdds.push(value)
    seen.add(value)
  }

  // 2. HIDE — drop everything in `overlay.hide`, except the selected value.
  const hideSet = new Set(overlay.hide ?? [])
  const afterHide = withAdds.filter((value) => !hideSet.has(value) || value === selectedValue)
  // The selected value might be hidden AND absent from withAdds entirely —
  // e.g. a descriptor that dropped an old model the user is still pinned
  // to, with no `add` entry reintroducing it. Surface it anyway; the same
  // "never silently lose sight of what's actually running" invariant as
  // the hide-exception above, just for the case where there's nothing to
  // un-hide because it was never in the working set to begin with.
  if (selectedValue && !afterHide.includes(selectedValue)) {
    afterHide.push(selectedValue)
  }

  // 3. ORDER — named entries first (in the given order), then the rest in
  // their existing relative order. Names with no match in the working set
  // are ignored rather than thrown.
  const order = overlay.order ?? []
  if (order.length === 0) return afterHide

  const remaining = new Set(afterHide)
  const ordered: string[] = []
  for (const value of order) {
    if (!remaining.has(value)) continue
    ordered.push(value)
    remaining.delete(value)
  }
  for (const value of afterHide) {
    if (remaining.has(value)) ordered.push(value)
  }
  return ordered
}
