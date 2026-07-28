interface LayoutRef {
  id: string
}

interface DeleteLayoutAndReconcileOptions<T extends LayoutRef> {
  layoutId: string
  deleteLayout: (layoutId: string) => Promise<void>
  invalidatePanesSnapshot: () => void
  listRemainingLayouts: () => Promise<T[]>
  getActiveLayoutId: () => string | null
  selectLayout: (layoutId: string | null) => void
}

/**
 * Deletes a layout and reconciles the shared selection with the source of
 * truth. PanesView's independent snapshot must be invalidated before an
 * active-layout selection write; otherwise its stale list can immediately
 * seed the deleted id again when the final layout is cleared.
 */
export async function deleteLayoutAndReconcile<T extends LayoutRef>({
  layoutId,
  deleteLayout,
  invalidatePanesSnapshot,
  listRemainingLayouts,
  getActiveLayoutId,
  selectLayout
}: DeleteLayoutAndReconcileOptions<T>): Promise<T[]> {
  await deleteLayout(layoutId)
  invalidatePanesSnapshot()

  const remainingLayouts = await listRemainingLayouts()
  if (getActiveLayoutId() === layoutId) {
    const sibling = remainingLayouts.find((layout) => layout.id !== layoutId)
    selectLayout(sibling?.id ?? null)
  }

  return remainingLayouts
}
