import { ElectronAPI } from '@electron-toolkit/preload'
import type { DoctorResult } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      config: {
        openFolder: () => Promise<string | null>
      }
      doctor: {
        check: () => Promise<DoctorResult>
      }
    }
  }
}
