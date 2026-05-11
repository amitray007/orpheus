import { useEffect, useState } from 'react'
import { TitleBarDragRegion } from './components/TitleBarDragRegion'
import { MainPage } from './components/MainPage'
import { ClaudeMissingModal } from './components/ClaudeMissingModal'
import type { DoctorResult } from '@shared/types'

function App(): React.JSX.Element {
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)
  // TEMP(preview): ⌘⇧M toggles a forced claude-missing modal so we can
  //                eyeball the surface without moving the real binary.
  //                Remove this state + the keydown effect together when
  //                the preview is no longer needed.
  const [forceMissingModal, setForceMissingModal] = useState(false)

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

  // TEMP(preview): keyboard shortcut to toggle the modal regardless of doctor
  //                state. Paired with the `forceMissingModal` state above —
  //                remove both together.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        setForceMissingModal((v) => !v)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Always render MainPage; overlay the modal when claude is missing OR forced.
  const projects = doctor?.existingProjects ?? []
  const claudeMissing = doctor !== null && !doctor.claudeInstalled
  const showMissingModal = claudeMissing || forceMissingModal

  return (
    <main className="app pt-9">
      <TitleBarDragRegion />
      <MainPage existingProjects={projects} />
      {showMissingModal && <ClaudeMissingModal onRecheck={runDoctor} />}
    </main>
  )
}

export default App
