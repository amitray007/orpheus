import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { DiagConsole } from '@/components/diag/DiagConsole'
import { installRendererErrorCapture } from '@/lib/diag'
import { initOverlayDevTest } from '@/lib/overlayDevTest'

const viewParam = new URLSearchParams(location.search).get('view')
const isDiagConsole = viewParam === 'diag-console'

if (!isDiagConsole) {
  installRendererErrorCapture()
  initOverlayDevTest()
}

function renderView(): React.JSX.Element {
  if (isDiagConsole) return <DiagConsole />
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode>{renderView()}</StrictMode>)
