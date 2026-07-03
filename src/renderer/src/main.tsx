import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { DiagConsole } from '@/components/diag/DiagConsole'
import { PierreSmokePage } from '@/components/workbench/__pierre_smoke__'
import { installRendererErrorCapture } from '@/lib/diag'
import { initOverlayDevTest } from '@/lib/overlayDevTest'

const viewParam = new URLSearchParams(location.search).get('view')
const isDiagConsole = viewParam === 'diag-console'
// U1 (P0) dev-only escape hatch — see components/workbench/__pierre_smoke__.tsx.
// Never reachable in production builds; throwaway, deleted once U9/U10 land.
const isPierreSmoke = viewParam === 'pierre-smoke' && __ORPHEUS_MODE__ !== 'production'

if (!isDiagConsole && !isPierreSmoke) {
  installRendererErrorCapture()
  initOverlayDevTest()
}

function renderView(): React.JSX.Element {
  if (isDiagConsole) return <DiagConsole />
  if (isPierreSmoke) return <PierreSmokePage />
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode>{renderView()}</StrictMode>)
