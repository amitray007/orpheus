import '../assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { OverlayRoot } from './OverlayRoot'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OverlayRoot />
  </StrictMode>
)

// Pre-warm/crash-recovery ready ping — main gates the `recovering -> idle`
// transition on this (U4).
window.overlayApi.ready()
