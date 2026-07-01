declare const __ORPHEUS_MODE__: 'development' | 'production' | 'worktree'

export const isWorktreeBuild = __ORPHEUS_MODE__ === 'worktree'
// isDev stays true for BOTH development and worktree builds, so dev-only UI (badges, updates section gating) behaves the same in the WT variant.
export const isDev = __ORPHEUS_MODE__ === 'development' || __ORPHEUS_MODE__ === 'worktree'

export const APP_NAME =
  __ORPHEUS_MODE__ === 'worktree'
    ? 'Orpheus WT'
    : __ORPHEUS_MODE__ === 'development'
      ? 'Orpheus Dev'
      : 'Orpheus'
export const APP_ID =
  __ORPHEUS_MODE__ === 'worktree'
    ? 'dev.orpheus.wt'
    : __ORPHEUS_MODE__ === 'development'
      ? 'dev.orpheus.dev'
      : 'dev.orpheus.app'
