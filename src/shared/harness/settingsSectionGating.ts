// ---------------------------------------------------------------------------
// src/shared/harness/settingsSectionGating.ts
//
// Pure decision function for which Settings UI sections should render,
// given the set of currently REGISTERED harnesses — closes the gap where
// HarnessDescriptor.settingsSections (src/main/harness/registry.ts) was
// populated with the 11 claude-* section ids but consumed by nothing:
// HarnessSummary had no field for it, toSummary() didn't project it, and
// SettingsView.tsx's GROUPS rendered all 34 sections (23 orpheus-* +
// 11 claude-*) unconditionally, regardless of which harness(es) exist.
//
// THE GRANULARITY IS "REGISTERED", NOT "ACTIVE WORKSPACE'S HARNESS".
// SettingsView is a single app-wide page — src/renderer/src/components/
// dashboard/MainContent.tsx mounts exactly one, with no workspace/project
// scope threaded in — so there is no single "current harness" to gate
// against even if there were. HARNESSES (registry.ts) is a REGISTRY, not a
// selection: multiple harnesses coexisting is the whole point of the
// migration this file is part of. The correct question a settings section
// answers is therefore "does ANY registered harness declare this section",
// not "does THE active harness declare it" — a section a second harness
// doesn't use must still show as long as a DIFFERENT registered harness
// (e.g. Claude) still does. With only Claude registered (today, and for
// the whole current release), every claude-* section has exactly one
// declaring harness, so this degenerates to "Claude declares it" — the
// regression net this unit's own verifier pins byte-for-byte.
//
// A section id ALONE cannot tell you whether it is "harness-owned" (should
// be gated) or "harness-agnostic" (never gated) — registry.ts's own
// settingsSections is JUST a flat string array, no separate list of "every
// section id any descriptor could ever claim" exists anywhere to check an
// id against independent of who happens to be registered right now (a
// first version of this module tried to infer that from "is this id
// claimed by ANY currently-registered harness", which is circular: with
// only Claude registered, an id absent from Claude's OWN settingsSections
// is indistinguishable from an id no descriptor anywhere has ever claimed
// — the same "claimed by nobody in `harnesses`" signal covers both, so a
// function taking only `harnesses` can never actually hide a claude-* id).
//
// So the caller supplies the answer STRUCTURALLY instead: SettingsView.tsx
// already knows, from its own GROUPS array, which literal group ('Orpheus'
// vs 'Claude') a section belongs to — that grouping IS the harness-owned/
// harness-agnostic split, expressed as real code structure rather than a
// naming convention this module would otherwise have to hardcode
// (`sectionId.startsWith('claude-')`, exactly the kind of string-matching
// gate the multi-harness migration has been removing everywhere else).
// isGatedSectionGroup below takes that one boolean per GROUP (not per
// section id) — true for a group whose sections are harness-owned and
// therefore SUBJECT to gating, false for a group that is never gated
// (Orpheus's app-level settings). See filterSectionGroup's own doc comment
// for the exact contract SettingsView.tsx's call site relies on.
// ---------------------------------------------------------------------------

/** The minimal shape this module needs off a harness summary/descriptor —
 *  a structural type (mirrors actionTypeGating.ts's ActionGateHarness
 *  precedent) so both HarnessSummary (renderer, IPC-crossed) and
 *  HarnessDescriptor (main) satisfy it with no adapter. */
export interface SettingsSectionGateHarness {
  settingsSections: string[]
}

/**
 * Whether `sectionId` should render, for a GATED group (isGatedSectionGroup
 * true for the group this id belongs to — see this file's header for why
 * gating is decided per-GROUP by the caller, not inferred per-id here).
 *
 * True iff at least one currently-registered harness in `harnesses`
 * declares `sectionId` in its own settingsSections. `harnesses.length ===
 * 0` (harness:list still loading / fetch failed) fails OPEN — shows the
 * section rather than flashing an empty nav before the real list resolves;
 * unlike HarnessCapabilities' fail-CLOSED default (never grant a
 * capability you can't back), over-hiding a settings page the user needs
 * is the worse failure mode here, not under-hiding one during a brief
 * loading window.
 *
 * Callers for an UNGATED group (Orpheus's app-level sections) should
 * never call this at all — see filterSectionGroup, which only calls it for
 * a group whose `gated` flag is true and returns every section unfiltered
 * otherwise.
 */
export function isSectionIdApplicable(
  sectionId: string,
  harnesses: SettingsSectionGateHarness[]
): boolean {
  if (harnesses.length === 0) return true
  return harnesses.some((h) => h.settingsSections.includes(sectionId))
}

/**
 * Result of filtering one SectionGroup's members down to the applicable
 * ones. `isEmpty` lets a caller drop the whole group (its own nav header)
 * rather than render a group with a label and zero rows.
 */
export interface FilteredSectionGroup<TSection> {
  visibleSections: TSection[]
  isEmpty: boolean
}

/**
 * Filters one group's section list — generic over the caller's own
 * SectionDef shape (SettingsView.tsx has one; this module stays free of
 * any dependency on it) so this stays a pure array transform with no
 * React/component coupling. `getId` extracts the section id from whatever
 * shape TSection is.
 *
 * `gated` is the per-GROUP flag described in this file's header — true for
 * a harness-owned group (Claude's 11 sections today), false for a group
 * that is never filtered (Orpheus's app-level sections, which return
 * unfiltered regardless of `harnesses`). This is what lets the function
 * correctly show EVERY Orpheus section even when `harnesses` is a harness
 * that declares zero settingsSections of its own — an ungated group's
 * visibility was never a function of settingsSections to begin with.
 */
export function filterSectionGroup<TSection>(
  sections: TSection[],
  getId: (s: TSection) => string,
  harnesses: SettingsSectionGateHarness[],
  gated: boolean
): FilteredSectionGroup<TSection> {
  const visibleSections = gated
    ? sections.filter((s) => isSectionIdApplicable(getId(s), harnesses))
    : sections
  return { visibleSections, isEmpty: visibleSections.length === 0 }
}

/**
 * Resolves the active section id after filtering — if the CURRENTLY active
 * id got filtered out (the harness that declared it is no longer
 * registered, or was never registered this session), falls back to the
 * first visible section across every group, IN GROUP ORDER, rather than
 * silently landing the user on an unrelated page with no explanation. A
 * caller that wants to explain the fallback (e.g. a toast/notice) can
 * compare its own previous activeId against this function's return value —
 * this function itself only decides WHERE to land, not whether to announce
 * it.
 *
 * `visibleGroups` must already be filtered (filterSectionGroup per group,
 * empty groups dropped) — this function does no filtering of its own, only
 * fallback resolution, so it can be unit-tested independently of
 * filterSectionGroup's own list-transform logic.
 */
export function resolveActiveSectionId<TSection>(
  activeId: string,
  visibleGroups: { sections: TSection[] }[],
  getId: (s: TSection) => string
): string {
  const allVisibleIds = visibleGroups.flatMap((g) => g.sections.map(getId))
  if (allVisibleIds.includes(activeId)) return activeId
  return allVisibleIds[0] ?? activeId // no visible section at all (degenerate) -> keep activeId rather than crash
}
