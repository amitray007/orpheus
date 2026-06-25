import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/App'
import { DiagConsole } from '@/components/diag/DiagConsole'
import { installRendererErrorCapture } from '@/lib/diag'

const isDiagConsole = new URLSearchParams(location.search).get('view') === 'diag-console'

if (!isDiagConsole) {
  installRendererErrorCapture()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isDiagConsole ? <DiagConsole /> : <App />}</StrictMode>
)
