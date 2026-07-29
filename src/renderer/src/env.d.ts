/// <reference types="vite/client" />

declare const __ORPHEUS_MODE__: 'development' | 'production' | 'worktree' | 'nightly'

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.webp' {
  const src: string
  export default src
}
