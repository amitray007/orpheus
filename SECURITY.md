# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **hey@amitray.dev** with a description of the issue and steps to reproduce. This is
an early-preview personal project, so response is best-effort, but I will acknowledge
valid reports within a reasonable window (typically a few business days) and work toward
a fix in the next release.

## Supported Versions

Only the **latest release** is supported. This is early-preview software under active
development; there are no long-term-support branches or backport commitments.

## Threat Model (Local-First)

Orpheus is a single-user desktop app. Its threat model assumes the local user account is
trusted. It does **not** defend against an attacker who already has code execution as the
same user — that attacker already controls the machine and all files within it. No network
service is exposed to other machines; all inter-process communication is local to the
running host.

## Credentials at Rest (Deliberate Trade-Off)

Claude/Anthropic credentials (API keys, auth tokens) are stored **in plaintext** in the
app's local SQLite database:

- Production: `~/Library/Application Support/Orpheus/orpheus.sqlite`
- Dev build: `~/Library/Application Support/Orpheus Dev/orpheus.sqlite`

**Why not the macOS Keychain?** Orpheus is currently ad-hoc codesigned (no Apple
Developer ID). Ad-hoc re-signing reshuffles Keychain ACLs on every build, making
Keychain-backed storage unworkable in practice at this stage. Moving to
`safeStorage`/Keychain is planned once Developer ID signing is in place.

**Practical exposure:** the plaintext storage is equivalent to a dotfile such as
`~/.aws/credentials` or a `.env` file — readable only by processes running as the same
local user. This is an acceptable trade-off given the local-first threat model above, but
it is a real one:

> **Treat `orpheus.sqlite` as a sensitive file. Anyone with read access to your user
> account (local or remote) can read your Anthropic credentials from it.**

## Code Signing

Orpheus is currently **ad-hoc signed and not notarized** by Apple. Distribution is via a
private Homebrew tap, which installs the app and removes the macOS quarantine flag.
Developer ID signing and notarization are planned future improvements.

## Local IPC / Notification Socket

The app runs a Unix-domain socket for internal hook notifications. The socket lives inside
the per-user app-data directory with owner-only permissions and is not reachable from
other machines or other user accounts on the same machine.

## Renderer Hardening

The Electron renderer process runs with:

- `contextIsolation` enabled
- `nodeIntegration` disabled
- A strict Content-Security-Policy
- No remote content loaded into the renderer

The renderer communicates with the main process exclusively through a narrow, typed
preload bridge (`window.api.*`). There is no direct Node.js or native access from
renderer code.
