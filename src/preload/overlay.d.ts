import type {
  OverlayShowMessage,
  OverlayUpdateMessage,
  OverlaySizeReport,
  OverlayAck,
  OverlayEvent
} from '../shared/types'

declare global {
  interface Window {
    overlayApi: {
      onShow: (cb: (msg: OverlayShowMessage) => void) => () => void
      onUpdate: (cb: (msg: OverlayUpdateMessage) => void) => () => void
      onThemeChange: (cb: (theme: string) => void) => () => void
      onHide: (cb: (msg: { id: string; generation: number }) => void) => () => void
      ackPainted: (ack: OverlayAck) => void
      reportSize: (report: OverlaySizeReport) => void
      sendEvent: (e: OverlayEvent) => void
      ready: () => void
    }
  }
}

export {}
