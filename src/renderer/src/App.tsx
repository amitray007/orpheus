import { useEffect, useState } from 'react'
import { TitleBarDragRegion } from './components/TitleBarDragRegion'
import { MainPage } from './components/MainPage'
import { Setup } from './components/Setup'
import type { DoctorResult } from '@shared/types'

function App(): React.JSX.Element {
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)
  const [setupCompleted, setSetupCompleted] = useState<boolean | null>(null)

  async function runDoctor(): Promise<void> {
    const result = await window.api.doctor.check()
    setDoctor(result)
  }

  useEffect(() => {
    async function loadInitial(): Promise<void> {
      const [completed] = await Promise.all([
        window.api.config.getSetupCompleted(),
        runDoctor()
      ])
      setSetupCompleted(completed)
    }
    loadInitial().catch((err) => console.error('[app] initial load failed', err))
  }, [])

  async function handleFinish(): Promise<void> {
    await window.api.config.setSetupCompleted(true)
    setSetupCompleted(true)
  }

  return (
    <main className="app pt-9">
      <TitleBarDragRegion />
      {doctor === null || setupCompleted === null ? null : setupCompleted ? (
        <MainPage existingProjects={doctor.existingProjects} />
      ) : (
        <Setup doctor={doctor} onFinish={handleFinish} onRecheck={runDoctor} />
      )}
    </main>
  )
}

export default App
