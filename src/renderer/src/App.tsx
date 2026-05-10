import { useState, useEffect } from 'react'
import { TitleBarDragRegion } from './components/TitleBarDragRegion'
import { Onboarding } from './components/Onboarding'
import { DashboardPlaceholder } from './components/DashboardPlaceholder'

type LoadState = 'loading' | 'no-key' | 'has-key'

function App(): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>('loading')

  useEffect(() => {
    window.api.config
      .getApiKey()
      .then((key) => {
        setLoadState(key ? 'has-key' : 'no-key')
      })
      .catch((err) => {
        console.error('[app] getApiKey failed', err)
        setLoadState('no-key')
      })
  }, [])

  function handleKeySaved(): void {
    setLoadState('has-key')
  }

  return (
    <main className="app pt-9">
      <TitleBarDragRegion />

      {loadState === 'loading' && (
        /* Tiny skeleton while IPC resolves — keep it invisible, no flash */
        <div className="sr-only" aria-live="polite">
          Loading…
        </div>
      )}

      {loadState === 'no-key' && <Onboarding onKeySaved={handleKeySaved} />}

      {loadState === 'has-key' && <DashboardPlaceholder />}
    </main>
  )
}

export default App
