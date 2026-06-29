import { useEffect, useState } from 'react'

/**
 * Tracks whether a newer Orpheus build is available (drives the sidebar-footer
 * update indicator). Reads the current snapshot on mount, then stays in sync
 * via the `onCheckResult` push channel and re-fetches after an install finishes
 * so the indicator clears once the user is up to date.
 *
 * Returns `{ available, latest }` where `latest` is the version string of the
 * newest known build (e.g. `"v0.5.3"`) or `null` when unknown.
 */
export function useUpdateAvailable(): { available: boolean; latest: string | null } {
  const [state, setState] = useState<{ available: boolean; latest: string | null }>({
    available: false,
    latest: null
  })

  useEffect(() => {
    let cancelled = false

    void window.api.updates
      .getState()
      .then((snap) => {
        if (!cancelled) setState({ available: snap.kind === 'available', latest: snap.latest })
      })
      .catch(() => {})

    const offCheckResult = window.api.updates.onCheckResult((result) => {
      setState({ available: result.available, latest: result.latest })
    })

    const offDone = window.api.updates.onDone((e) => {
      if (!e.success) return
      void window.api.updates
        .getState()
        .then((snap) => setState({ available: snap.kind === 'available', latest: snap.latest }))
        .catch(() => {})
    })

    return () => {
      cancelled = true
      offCheckResult()
      offDone()
    }
  }, [])

  return state
}
