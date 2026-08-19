// ---------------------------------------------------------------------------
// src/shared/harness/doctor.ts
//
// Pure decision logic over DoctorResult (src/shared/types.ts). Kept here —
// not inline in App.tsx or index.ts — so the boot-gate decision ("is ANY
// harness installed?") is a plain, Electron-free function a harness can
// assert directly, per CLAUDE.md's "assert behaviour, not source text"
// discipline. No imports beyond the shared type; must stay side-effect-free.
// ---------------------------------------------------------------------------

import type { DoctorResult } from '../types'

/** The boot gate: true iff at least one registered harness is installed.
 *  The missing-harness modal shows exactly when this is false — never per
 *  individual harness. With exactly one registered harness (today's Claude-
 *  only state), this is equivalent to the old `claudeInstalled` boolean. */
export function isAnyHarnessInstalled(result: DoctorResult): boolean {
  return result.harnesses.some((h) => h.installed)
}

/** Per-harness install check, for callers that care about one specific
 *  harness (e.g. a future per-workspace gate) rather than the app-wide boot
 *  gate. Returns false for an id absent from the result entirely. */
export function isHarnessInstalled(result: DoctorResult, harnessId: string): boolean {
  return result.harnesses.some((h) => h.id === harnessId && h.installed)
}
