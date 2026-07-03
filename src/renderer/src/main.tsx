import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { DiagConsole } from '@/components/diag/DiagConsole'
import { installRendererErrorCapture } from '@/lib/diag'
import { initOverlayDevTest } from '@/lib/overlayDevTest'

const isDiagConsole = new URLSearchParams(location.search).get('view') === 'diag-console'

if (!isDiagConsole) {
  installRendererErrorCapture()
  initOverlayDevTest()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isDiagConsole ? (
      <DiagConsole />
    ) : (
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    )}
  </StrictMode>
)
