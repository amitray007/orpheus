import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      config: {
        getApiKey: () => Promise<string | null>
        setApiKey: (key: string) => Promise<boolean>
        openFolder: () => Promise<string | null>
      }
    }
  }
}
