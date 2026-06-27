// react-doctor configuration (https://react.doctor/docs/configuration)
//
// We run react-doctor via `npx react-doctor@latest`; this file is auto-discovered
// at the repo root. It is intentionally a plain default export (no
// `react-doctor/api` import) so it adds no dependency for our own tsc/eslint.
//
// `ignore.files` excludes code we do not own or maintain:
//   - vendor/**     prebuilt/vendored libghostty + upstream ghostty source pin
//                   (fetched + SHA-verified by scripts/fetch-libghostty.sh; its
//                   own GitHub Actions workflows tripped the Security rules).
//   - .claude/**    local agent worktrees and tooling (e.g. xterm-experiment),
//                   which duplicated findings from real src/ files.
//
// NOTE: the `react-doctor/no-unused-dependency` rule is left ENABLED on purpose.
// It currently flags `geist` (a false positive — used via src/renderer/.../main.css
// and src/main/index.ts). The signal is preserved so any genuinely unused deps
// added in future are caught.
export default {
  ignore: {
    files: ['vendor/**', '.claude/**']
  }
}
