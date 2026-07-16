// Commitlint config for Orpheus.
// Extends @commitlint/config-conventional with relaxed overrides to match
// this project's real commit style without flagging existing history.
//
// Intentional relaxations:
//   - header-max-length: disabled (several subjects exceed 100 chars)
//   - subject-case: disabled (mixed-case subjects are common here)
//   - scope-empty / scope-case: permissive (scopes like "keep-awake", "diag"
//     must pass; scope is optional)
//
// wagoid/commitlint-github-action bundles @commitlint/config-conventional,
// so no additional devDependencies are required.

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Turn off length cap — some subjects in this repo exceed 100 chars.
    'header-max-length': [0, 'always', 200],
    // Allow any casing in the subject line.
    'subject-case': [0],
    // Enumerate all commit types actually used in this repo.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'refactor', 'docs', 'perf', 'build', 'ci', 'style', 'test', 'revert']
    ],
    // Scopes are optional; no casing restriction.
    'scope-empty': [0],
    'scope-case': [0]
  }
}
