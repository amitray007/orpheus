declare const __ORPHEUS_MODE__: 'development' | 'production' | 'worktree' | 'nightly'

export const isWorktreeBuild = __ORPHEUS_MODE__ === 'worktree'
export const isNightly = __ORPHEUS_MODE__ === 'nightly'
// isDev stays true for BOTH development and worktree builds, so dev-only UI (badges, updates section gating) behaves the same in the WT variant.
// Nightly is a real distributed build (ships via Homebrew), NOT a local dev
// build, so it deliberately stays OUT of isDev — nightly must be treated like
// production for dev-only UI gating (badges, updates-section gating, etc).
export const isDev = __ORPHEUS_MODE__ === 'development' || __ORPHEUS_MODE__ === 'worktree'

export const APP_NAME =
  __ORPHEUS_MODE__ === 'worktree'
    ? 'Orpheus WT'
    : __ORPHEUS_MODE__ === 'development'
      ? 'Orpheus Dev'
      : __ORPHEUS_MODE__ === 'nightly'
        ? 'Orpheus Nightly'
        : 'Orpheus'
export const APP_ID =
  __ORPHEUS_MODE__ === 'worktree'
    ? 'dev.orpheus.wt'
    : __ORPHEUS_MODE__ === 'development'
      ? 'dev.orpheus.dev'
      : __ORPHEUS_MODE__ === 'nightly'
        ? 'dev.orpheus.nightly'
        : 'dev.orpheus.app'
