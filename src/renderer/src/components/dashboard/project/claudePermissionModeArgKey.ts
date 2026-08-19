// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/project/claudePermissionModeArgKey.ts
//
// Renderer-side mirror of CLAUDE_PERMISSION_MODE_ARG_KEY
// (src/main/harness/claude/curated.ts) — check:arch forbids importing
// src/main from the renderer, so this one string constant is re-declared
// here rather than imported, the same "renderer-safe mirror" convention
// src/shared/types.ts already documents for HarnessSettingRow/HarnessSettings
// (kept field-for-field identical to their src/main namesakes on purpose).
// If Claude's flag name ever changes, update BOTH — same discipline as that
// header describes.
// ---------------------------------------------------------------------------

export const CLAUDE_PERMISSION_MODE_ARG_KEY = '--permission-mode'
