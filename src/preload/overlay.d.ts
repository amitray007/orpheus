declare global {
  interface Window {
    overlayApi: {
      ping: () => Promise<string>
      onPing: (cb: (e: { message: string }) => void) => () => void
    }
  }
}

export {}
