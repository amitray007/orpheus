declare const __ORPHEUS_MODE__: 'development' | 'production'

export const isDev = __ORPHEUS_MODE__ === 'development'

export const APP_NAME = isDev ? 'Orpheus Dev' : 'Orpheus'
export const APP_ID = isDev ? 'dev.orpheus.dev' : 'dev.orpheus.app'
