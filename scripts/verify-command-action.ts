import assert from 'node:assert/strict'
import { parseCommandAction } from '../src/main/commandAction'

assert.equal(parseCommandAction({ action: 'workspace.list' }), 'workspace.list')

for (const body of [
  { action: ['workspace.list'] },
  { action: { toString: () => 'workspace.list' } },
  { action: 1 },
  { action: true },
  { action: null },
  { action: '' },
  { action: ' workspace.list' },
  { action: 'workspace.list ' },
  { action: 'a'.repeat(129) },
  null,
  []
]) {
  assert.equal(
    parseCommandAction(body),
    null,
    'command actions must be bounded, non-empty, exact strings'
  )
}

console.log('Command action parsing verification passed.')
