import { useEffect, useState } from 'react'
import { Dashboard } from './components/dashboard/Dashboard'
import { HarnessMissingModal } from './components/HarnessMissingModal'
import { DiffWorkerPoolProvider } from './components/workbench/DiffWorkerPoolProvider'
import type { DoctorResult } from '@shared/types'
import { isAnyHarnessInstalled } from '@shared/harness/doctor'

// Optimistic initial state: assume a harness is installed so the Dashboard
// mounts immediately on first paint. The real doctor.check() IPC resolves
// asynchronously and updates this state; the missing-harness modal only
// shows once the real check comes back with nothing installed (never during
// the optimistic window). The empty `harnesses` array itself never reaches
// isAnyHarnessInstalled — doctorResolved gates that below — so it doesn't
// need a fake entry to read as "installed".
const OPTIMISTIC_DOCTOR: DoctorResult = { harnesses: [] }

function App(): React.JSX.Element {
  const [doctor, setDoctor] = useState<DoctorResult>(OPTIMISTIC_DOCTOR)
  // Track whether the real doctor check has resolved so we never flash the
  // missing-harness modal during the optimistic boot window.
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
  // optimistic window — so a user with any harness installed never sees a
  // flash. The gate is "no registered harness at all", not "Claude
  // specifically" — see isAnyHarnessInstalled.
  const showMissingModal = doctorResolved && !isAnyHarnessInstalled(doctor)

  return <AppShell doctor={doctor} runDoctor={runDoctor} showMissingModal={showMissingModal} />
}

interface AppShellProps {
  doctor: DoctorResult
  runDoctor: () => Promise<void>
  showMissingModal: boolean
}

function AppShell({ doctor, runDoctor, showMissingModal }: AppShellProps): React.JSX.Element {
  return (
    <main className="app h-full">
      {/* App-wide singleton — see DiffWorkerPoolProvider.tsx. Wraps every
          workspace so all Git/Files tabs across the whole app share ONE
          @pierre/diffs worker pool instead of spinning one up per workspace. */}
      <DiffWorkerPoolProvider>
        <Dashboard />
      </DiffWorkerPoolProvider>
      {showMissingModal && <HarnessMissingModal doctor={doctor} onRecheck={runDoctor} />}
    </main>
  )
}

export default App
