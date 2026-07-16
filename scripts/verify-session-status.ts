/**
 * verify-session-status.ts — regression harness for sessionState's raw
 * session-file status → WorkspaceStatus mapping.
 *
 * Guards against the "shell" status regression: claude CLI v2.1.207+ writes
 * a new session-file status value `"shell"` (while a Bash/shell tool runs)
 * that older Orpheus code didn't recognize, causing workspaces to be
 * incorrectly driven to `idle` mid-command instead of staying `in_progress`.
 *
 * This imports the REAL `_mapFileStatus` function from
 * src/main/sessionStatusMap.ts — a deliberately dependency-free module (no
 * electron/db imports) extracted from sessionState.ts specifically so this
 * pure mapping logic can be exercised directly under plain `bun run`.
 * (Importing sessionState.ts itself transitively pulls in the `electron`
 * module, which throws outside the Electron runtime — confirmed by probe
 * during this fix's development.)
 *
 * Run: bun run scripts/verify-session-status.ts
 */

import assert from 'node:assert'
import { _mapFileStatus } from '../src/main/sessionStatusMap.ts'

// shell → in_progress (the regression this fix addresses)
assert.equal(_mapFileStatus({ status: 'shell' }), 'in_progress', 'shell must map to in_progress')

// busy → in_progress
assert.equal(_mapFileStatus({ status: 'busy' }), 'in_progress', 'busy must map to in_progress')

// waiting + permission prompt → attention
assert.equal(
  _mapFileStatus({ status: 'waiting', waitingFor: 'permission prompt' }),
  'attention',
  'waiting with waitingFor="permission prompt" must map to attention'
)

// waiting (no permission prompt) → awaiting_input
assert.equal(
  _mapFileStatus({ status: 'waiting' }),
  'awaiting_input',
  'waiting without a permission-prompt reason must map to awaiting_input'
)
assert.equal(
  _mapFileStatus({ status: 'waiting', waitingFor: 'input needed' }),
  'awaiting_input',
  'waiting with a non-permission waitingFor must map to awaiting_input'
)

// idle → idle
assert.equal(_mapFileStatus({ status: 'idle' }), 'idle', 'idle must map to idle')

console.log('✓ session status mapping (shell/busy/waiting/idle)')
console.log('PASS: verify-session-status')
