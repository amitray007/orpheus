import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCommandAction } from '../src/main/commandAction.ts'

assert.equal(parseCommandAction({ action: 'automations.phase8Qa' }), 'automations.phase8Qa')

const invalidBodies: unknown[] = [
  { action: ['automations.phase8Qa'] },
  { action: { toString: () => 'automations.phase8Qa' } },
  { action: 1 },
  { action: true },
  { action: null },
  { action: '' },
  { action: ' automations.phase8Qa' },
  { action: 'a'.repeat(129) },
  null,
  []
]

let qaHandlerCalls = 0
const dispatch: Record<string, () => void> = {
  'automations.phase8Qa': () => {
    qaHandlerCalls++
  }
}

// Model the boundary after the ordinary command token has already passed.
// A non-string JSON action must not become a property key and reach QA without
// the separate credential check.
for (const body of invalidBodies) {
  const action = parseCommandAction(body)
  assert.equal(action, null)
  if (action != null) dispatch[action]?.()
}
assert.equal(qaHandlerCalls, 0)

const commandServerSource = readFileSync(
  join(import.meta.dir, '../src/main/commandServer.ts'),
  'utf8'
)
const parseIndex = commandServerSource.indexOf('const action = parseCommandAction(body)')
const qaAuthIndex = commandServerSource.indexOf('action === PHASE8_QA_COMMAND', parseIndex)
const dispatchIndex = commandServerSource.indexOf(
  'const handler = resolveCmdHandler(dispatch, action)',
  parseIndex
)
assert.ok(parseIndex >= 0)
assert.ok(qaAuthIndex > parseIndex)
assert.ok(dispatchIndex > qaAuthIndex)
assert.ok(
  commandServerSource.slice(parseIndex, qaAuthIndex).includes("error: 'invalid action'"),
  'invalid actions must return before the Phase 8 credential branch'
)

console.log('✓ Phase 8 QA command action authentication boundary')
