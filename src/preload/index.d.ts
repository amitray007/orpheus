import { ElectronAPI } from '@electron-toolkit/preload'
import type { DoctorResult } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      app: {
        getVersion: () => Promise<string>
      }
      config: {
        openFolder: () => Promise<string | null>
      }
      doctor: {
        check: () => Promise<DoctorResult>
      }
    }
  }
}
