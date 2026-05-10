import { useState } from 'react'
import { Button } from './Button'

export function MainPage(): React.JSX.Element {
  const [openingFolder, setOpeningFolder] = useState(false)

  async function handleOpenFolder(): Promise<void> {
    if (openingFolder) return
    setOpeningFolder(true)
    try {
      const path = await window.api.config.openFolder()
      if (path) {
        console.log('[orpheus] folder picked:', path)
      }
    } finally {
      setOpeningFolder(false)
    }
  }

  return (
    <div className="flex items-center justify-center w-full h-full">
      <div className="flex flex-col items-center gap-2">
        {/* Wordmark */}
        <h1 className="text-5xl font-bold tracking-tight text-text-primary">
          Orpheus<span className="text-accent">.</span>
        </h1>

        {/* Tagline */}
        <p className="text-sm text-text-secondary">A Mac IDE built around Claude Code.</p>

        {/* CTAs */}
        <div className="flex gap-3 mt-8">
          <Button variant="primary" size="md" loading={openingFolder} onClick={handleOpenFolder}>
            + Add repository
          </Button>
          <Button variant="secondary" size="md" loading={openingFolder} onClick={handleOpenFolder}>
            Open folder…
          </Button>
        </div>
      </div>
    </div>
  )
}
