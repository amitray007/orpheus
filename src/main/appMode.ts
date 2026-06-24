declare const __ORPHEUS_MODE__: 'development' | 'production'
declare const __ORPHEUS_VARIANT_NAME__: string // e.g. 'Orpheus Xterm' ('' = none)
declare const __ORPHEUS_VARIANT_ID__: string // e.g. 'dev.orpheus.xterm' ('' = none)
declare const __ORPHEUS_SHARE_DATA_WITH__: string // e.g. 'Orpheus Dev' ('' = use own data)

export const isDev = __ORPHEUS_MODE__ === 'development'
// A named variant overrides the default dev/prod name+id. Empty = standard behavior.
const variantName = __ORPHEUS_VARIANT_NAME__
const variantId = __ORPHEUS_VARIANT_ID__
export const APP_NAME = variantName || (isDev ? 'Orpheus Dev' : 'Orpheus')
export const APP_ID = variantId || (isDev ? 'dev.orpheus.dev' : 'dev.orpheus.app')
// When set, the variant shares this other app's data dir instead of its own.
export const SHARE_DATA_WITH = __ORPHEUS_SHARE_DATA_WITH__
