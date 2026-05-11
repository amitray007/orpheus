import { useEffect, useState } from 'react'
import { TitleBarDragRegion } from './components/TitleBarDragRegion'
import { MainPage } from './components/MainPage'
import { MissingClaude } from './components/MissingClaude'
import type { DoctorResult } from '@shared/types'

function App(): React.JSX.Element {
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)

  async function runCheck(): Promise<void> {
    const result = await window.api.doctor.check()
    setDoctor(result)
  }

  useEffect(() => {
    runCheck().catch((err) => console.error('[app] doctor check failed', err))
  }, [])

  return (
    <main className="app pt-9">
      <TitleBarDragRegion />
      {doctor === null ? null : doctor.claudeInstalled ? (
        <MainPage existingProjects={doctor.existingProjects} />
      ) : (
        <MissingClaude onRecheck={runCheck} />
      )}
    </main>
  )
}

export default App
