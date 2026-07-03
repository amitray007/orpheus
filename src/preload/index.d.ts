import type { OrpheusApi } from './index'

declare global {
  interface Window {
    api: OrpheusApi
  }
}
