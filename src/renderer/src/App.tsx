import { useEffect, useState } from 'react'
import { Dashboard } from './components/dashboard/Dashboard'
import { ClaudeMissingModal } from './components/ClaudeMissingModal'
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
      {doctor !== null && <Dashboard claudeInstalled={doctor.claudeInstalled} />}
      {showMissingModal && <ClaudeMissingModal onRecheck={runDoctor} />}
    </main>
  )
}

export default App
