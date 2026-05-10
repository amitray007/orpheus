import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      config: {
        openFolder: () => Promise<string | null>
      }
    }
  }
}
