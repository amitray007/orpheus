import { useEffect, useState } from 'react'
import { Dashboard } from './components/dashboard/Dashboard'
import { ClaudeMissingModal } from './components/ClaudeMissingModal'
import { OverlayModeProvider } from './lib/OverlayModeProvider'
import type { DoctorResult } from '@shared/types'

// Optimistic initial state: assume claude is installed so the Dashboard
// mounts immediately on first paint. The real doctor.check() IPC resolves
// asynchronously and updates this state; the missing-claude modal only shows
// once the real check comes back false (never during the optimistic window).
const OPTIMISTIC_DOCTOR: DoctorResult = {
  claudeInstalled: true,
  claudeVersion: null,
  claudePath: null
}

function App(): React.JSX.Element {
  const [doctor, setDoctor] = useState<DoctorResult>(OPTIMISTIC_DOCTOR)
  // Track whether the real doctor check has resolved so we never flash the
  // missing-claude modal during the optimistic boot window.
  const [doctorResolved, setDoctorResolved] = useState(false)

  async function runDoctor(): Promise<void> {
    const result = await window.api.doctor.check()
    setDoctor(result)
    setDoctorResolved(true)
  }

  useEffect(() => {
    let cancelled = false
    window.api.doctor
      .check()
      .then((result) => {
        if (!cancelled) {
          setDoctor(result)
          setDoctorResolved(true)
        }
      })
      .catch((err) => console.error('[app] doctor check failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  // Only show the modal after the real check resolves — never during the
  // optimistic window — so claude-installed users never see a flash.
  const showMissingModal = doctorResolved && !doctor.claudeInstalled

  return (
    <OverlayModeProvider>
      <AppShell doctor={doctor} runDoctor={runDoctor} showMissingModal={showMissingModal} />
    </OverlayModeProvider>
  )
}

interface AppShellProps {
  doctor: DoctorResult
  runDoctor: () => Promise<void>
  showMissingModal: boolean
}

function AppShell({ doctor, runDoctor, showMissingModal }: AppShellProps): React.JSX.Element {
  return (
    <main className="app h-full">
      <Dashboard claudeInstalled={doctor.claudeInstalled} />
      {showMissingModal && <ClaudeMissingModal onRecheck={runDoctor} />}
    </main>
  )
}

export default App
