# Contributing to Orpheus

Orpheus is a **source-available** macOS project — it is not open-source.
The source code is public for transparency, evaluation, and personal learning only.
Ownership, licensing terms, and all rights remain with Amit Ray.
See [LICENSE](./LICENSE) for details.

This is an early-preview personal project. I welcome feedback and am open to
contributions, though the project is primarily developed by a single owner and
direction decisions are made at my sole discretion.

---

## Issues and feedback

Bug reports, feature ideas, and questions are all welcome. Please open a GitHub
issue. Using the provided issue templates helps keep reports actionable.

Before opening a new issue:

- Search existing issues to see whether it has already been reported.
- For bugs, include the Orpheus version (visible in the app's settings) and your
  macOS version.

---

## Code contributions

Pull requests are accepted at the owner's sole discretion. To avoid wasted effort,
please **open an issue to discuss your idea before doing significant work** — this
lets us confirm that it aligns with the project direction before you invest time.

Small, focused changes (typo fixes, well-scoped bug fixes) can be submitted
directly without prior discussion.

### Contribution terms

By submitting a pull request or any other contribution to this repository you:

1. **Confirm authorship.** You wrote the contribution yourself, or you have the
   legal right to submit it, and it does not introduce third-party code with
   incompatible licensing.

2. **Grant a license to the owner.** You grant Amit Ray a perpetual, irrevocable,
   worldwide, royalty-free right to use, reproduce, modify, sublicense,
   relicense, incorporate, and distribute your contribution as part of Orpheus,
   in any form and under any terms the owner chooses now or in the future.

3. **Acknowledge project ownership.** Your contribution becomes part of Orpheus
   under the project's existing license. You retain no ownership or control claim
   over the project, the Orpheus name, or the combined work.

> **Plain-English note:** this is not formal legal advice. For significant
> contributions I may ask you to sign a Contributor License Agreement (CLA) before
> the PR is merged. I'll reach out if that applies.

---

## Development setup

Orpheus targets **macOS only**.

**Prerequisites**

- macOS 13 or later
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- Xcode Command Line Tools (`xcode-select --install`)

**Install dependencies**

```bash
bun install
```

**Build and run (dev variant)**

```bash
# Quit any running dev build first, then:
bun run build:unpack
open "/Applications/Orpheus Dev.app"
```

`build:unpack` is the only correct local build command. It chains the native addon
rebuild → Vite bundle → electron-builder → re-sign → install as `Orpheus Dev.app`.
Do **not** run `bun run dev` (mismatches icon/bundle/signing) and do **not** run
the production build path (`build:mac`).

After the build you can sanity-check it launched:

```bash
pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1
```

**Other useful commands**

| Command                | What it does                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `bun run typecheck`    | Type-check main + preload + renderer                                                  |
| `bun run lint`         | ESLint over the whole workspace (`--max-warnings=146` ratchet in CI — only goes down) |
| `bun run format`       | Prettier-format the workspace                                                         |
| `bun run check`        | Aggregate gate: typecheck + lint + `check:dup` + `check:arch`                         |
| `bun run check:dup`    | `jscpd` duplication scan (2.4% threshold)                                             |
| `bun run check:arch`   | `depcruise` — no circular imports, layer rules enforced                               |
| `bun run check:dead`   | `knip` unused-export scan (advisory, not a hard gate)                                 |
| `bun run test:db`      | DB migration engine assertion harness (CI-gated on `src/main/db/**` changes)          |
| `bun run build:native` | Rebuild the native ghostty addon only                                                 |

There is one automated suite: the DB migration engine verifier (`bun run test:db`),
run in CI whenever `src/main/db/**` changes. There is no general unit/UI test
runner yet — manual testing against the dev build covers the rest.

Husky hooks run automatically and enforce quality on every commit/push:
`pre-commit` (lint-staged ESLint + Prettier), `commit-msg` (commitlint against
Conventional Commits), and `pre-push` (typecheck + the ESLint 146-warning
ratchet + `prettier --check`). CI additionally runs CodeQL static analysis and
OSV dependency vulnerability scanning, plus `actionlint` on workflow changes.

---

## Branch and commit conventions

- All work targets the `staging` branch. Do not open PRs against `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages: `feat(scope):`, `fix(scope):`, `chore(scope):`, etc. No emoji in
  commit subjects.
- Keep commits focused. One logical change per commit makes review easier.

---

## Before opening a pull request

Run the aggregate quality gate and fix any issues before submitting:

```bash
bun run check       # typecheck + lint + check:dup + check:arch
bun run format
```

Note the ESLint ratchet: CI enforces `--max-warnings=146`, and that ceiling only
moves down as warnings get fixed — don't introduce new ones. Husky's
`pre-commit`/`commit-msg`/`pre-push` hooks will also run automatically and catch
most of this for you.

Then build and do a manual smoke-test with `bun run build:unpack`.

---

## Questions?

Open a GitHub issue or reach out at [hey@amitray.dev](mailto:hey@amitray.dev).
