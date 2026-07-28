import assert from 'node:assert/strict'
import {
  buildWorkspaceSessionIds,
  getLiveSessionSnapshot,
  RuntimeObservationDeduper,
  type RuntimeObservation
} from '../src/main/sessionStateObservation'

const sessionIds = buildWorkspaceSessionIds([
  { id: 'workspace-1', claude_session_id: 'session-1' },
  { id: 'workspace-without-session', claude_session_id: null },
  { id: 'workspace-2', claude_session_id: 'session-2' }
])
assert.deepEqual(
  [...sessionIds],
  [
    ['workspace-1', 'session-1'],
    ['workspace-2', 'session-2']
  ]
)

let keyedReads = 0
const live = new Map([
  [
    'session-1',
    {
      pid: 42,
      status: 'busy' as const,
      version: 'test',
      cwd: '/project',
      statusUpdatedAt: 10
    }
  ]
])
const sessions: ReadonlyMap<string, typeof live extends Map<string, infer T> ? T : never> = {
  get size() {
    throw new Error('O(1) snapshot must not inspect registry size')
  },
  get(sessionId) {
    keyedReads++
    return live.get(sessionId)
  },
  has() {
    throw new Error('O(1) snapshot must use one keyed lookup')
  },
  entries() {
    throw new Error('O(1) snapshot must not iterate the registry')
  },
  keys() {
    throw new Error('O(1) snapshot must not iterate the registry')
  },
  values() {
    throw new Error('O(1) snapshot must not iterate the registry')
  },
  forEach() {
    throw new Error('O(1) snapshot must not iterate the registry')
  },
  [Symbol.iterator]() {
    throw new Error('O(1) snapshot must not iterate the registry')
  }
}
const snapshot = getLiveSessionSnapshot(sessions, 'session-1')
assert.equal(keyedReads, 1)
assert.deepEqual(snapshot, live.get('session-1'))
assert.notEqual(snapshot, live.get('session-1'))

const observation = (status: string): RuntimeObservation => ({
  workspaceId: 'workspace-1',
  claudeConversationId: 'session-1',
  session: {
    pid: 42,
    status,
    version: 'test',
    cwd: '/project',
    statusUpdatedAt: status === 'busy' ? 10 : 20
  }
})
const deduper = new RuntimeObservationDeduper()
assert.equal(deduper.shouldEmit(observation('busy')), true)
assert.equal(deduper.shouldEmit(observation('busy')), false)
assert.equal(deduper.shouldEmit(observation('idle')), true)
assert.equal(deduper.size(), 1)
deduper.prune(new Set(['workspace-2']))
assert.equal(deduper.size(), 0)
assert.equal(deduper.shouldEmit(observation('idle')), true)
deduper.clear()
assert.equal(deduper.size(), 0)

console.log('Session-state observation verification passed.')
