import { useEffect, useState } from 'react'
import { Dashboard } from './components/dashboard/Dashboard'
import { ClaudeMissingModal } from './components/ClaudeMissingModal'
import { DotmSquare11 } from './components/ui/dotm-square-11'
import type { DoctorResult } from '@shared/types'

function App(): React.JSX.Element {
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)

  async function runDoctor(): Promise<void> {
    const result = await window.api.doctor.check()
    setDoctor(result)
  }

  useEffect(() => {
    let cancelled = false
    window.api.doctor
      .check()
      .then((result) => {
        if (!cancelled) setDoctor(result)
      })
      .catch((err) => console.error('[app] doctor check failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  const showMissingModal = doctor !== null && !doctor.claudeInstalled

  return (
    <main className="app h-full">
      {doctor === null ? (
        // Boot splash — Geist Pixel wordmark + Echo Ring, shown briefly
        // while the doctor IPC resolves on first paint.
        <div className="h-full flex items-center justify-center">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-6xl tracking-tight text-text-primary leading-none select-none">
              Orpheus<span className="text-accent">.</span>
            </h1>
            <DotmSquare11 size={32} dotSize={3} speed={1.25} animated />
          </div>
        </div>
      ) : (
        <>
          <Dashboard claudeInstalled={doctor.claudeInstalled} />
          {showMissingModal && <ClaudeMissingModal onRecheck={runDoctor} />}
        </>
      )}
    </main>
  )
}

export default App
