import { useState } from 'react'
import { TitleBarDragRegion } from './components/TitleBarDragRegion'

function App(): React.JSX.Element {
  const [hidden, setHidden] = useState(false)

  async function handleHideSpike(): Promise<void> {
    await window.api.spike.unmount()
    setHidden(true)
  }

  return (
    <main className="app">
      <TitleBarDragRegion />
      {/* Spike-3 control: sits in the top-right, inside the drag strip row.
          Must have WebkitAppRegion no-drag so clicks are not eaten by the
          drag handler. */}
      <button
        onClick={handleHideSpike}
        disabled={hidden}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="fixed top-1 right-2 z-50 rounded px-2 py-0.5 text-xs font-medium
                   bg-white/10 text-white/70 hover:bg-white/20 disabled:opacity-30
                   disabled:cursor-not-allowed transition-colors"
      >
        {hidden ? 'Panel hidden' : 'Hide spike panel'}
      </button>
    </main>
  )
}

export default App
