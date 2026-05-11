import { ElectronAPI } from '@electron-toolkit/preload'
import type { DoctorResult } from '../shared/types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      config: {
        openFolder: () => Promise<string | null>
        getSetupCompleted: () => Promise<boolean>
        setSetupCompleted: (value: boolean) => Promise<boolean>
      }
      doctor: {
        check: () => Promise<DoctorResult>
      }
    }
  }
}
