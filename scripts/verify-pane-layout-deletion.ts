import assert from 'node:assert/strict'
import { deleteLayoutAndReconcile } from '../src/renderer/src/components/dashboard/paneLayoutDeletion'

interface Layout {
  id: string
}

async function runDeletion(args: {
  deletedLayoutId: string
  activeLayoutId: string | null
  remainingLayouts: Layout[]
}): Promise<{ events: string[]; selectionWrites: Array<string | null> }> {
  const events: string[] = []
  const selectionWrites: Array<string | null> = []

  await deleteLayoutAndReconcile({
    layoutId: args.deletedLayoutId,
    deleteLayout: async (layoutId) => {
      events.push(`delete:${layoutId}`)
    },
    invalidatePanesSnapshot: () => {
      events.push('invalidate')
    },
    listRemainingLayouts: async () => {
      events.push('list')
      return args.remainingLayouts
    },
    getActiveLayoutId: () => args.activeLayoutId,
    selectLayout: (layoutId) => {
      events.push(`select:${layoutId ?? 'null'}`)
      selectionWrites.push(layoutId)
    }
  })

  return { events, selectionWrites }
}

const activeFinalLayout = await runDeletion({
  deletedLayoutId: 'layout-final',
  activeLayoutId: 'layout-final',
  remainingLayouts: []
})
assert.deepEqual(activeFinalLayout.events, [
  'delete:layout-final',
  'invalidate',
  'list',
  'select:null'
])
assert.deepEqual(activeFinalLayout.selectionWrites, [null])

const activeFirstLayoutWithSibling = await runDeletion({
  deletedLayoutId: 'layout-first',
  activeLayoutId: 'layout-first',
  remainingLayouts: [{ id: 'layout-sibling' }]
})
assert.deepEqual(activeFirstLayoutWithSibling.events, [
  'delete:layout-first',
  'invalidate',
  'list',
  'select:layout-sibling'
])
assert.deepEqual(activeFirstLayoutWithSibling.selectionWrites, ['layout-sibling'])

const inactiveLayout = await runDeletion({
  deletedLayoutId: 'layout-inactive',
  activeLayoutId: 'layout-selected-sibling',
  remainingLayouts: [{ id: 'layout-selected-sibling' }]
})
assert.deepEqual(inactiveLayout.events, ['delete:layout-inactive', 'invalidate', 'list'])
assert.deepEqual(inactiveLayout.selectionWrites, [])

console.log(
  'verify-pane-layout-deletion: invalidation ordering and active/inactive selection behavior OK'
)
