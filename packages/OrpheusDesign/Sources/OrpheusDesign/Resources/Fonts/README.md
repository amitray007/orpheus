# Fonts

Drop the licensed font binaries here and the package picks them up at
runtime — `FontRegistry` walks this directory on first font access and
registers anything ending in `.otf`, `.ttf`, or `.ttc`.

## Expected files

### Satoshi (sans, UI chrome)

Indian Type Foundry / Fontshare. Commercial licence required. Static
faces, with PostScript names matching the registry's lookup:

- `Satoshi-Light.otf`
- `Satoshi-Regular.otf`
- `Satoshi-Medium.otf`
- `Satoshi-Bold.otf`
- `Satoshi-Black.otf`

Italics optional in v0 (no token uses them yet).

### Commit Mono (mono, code + terminal)

Eigil Nikolajsen / OFL — free to embed. PostScript names:

- `CommitMono-Light.otf`
- `CommitMono-Regular.otf`
- `CommitMono-Medium.otf`
- `CommitMono-Bold.otf`

## Without these files

The catalog and consumer modules still build and render — `OrpheusTypography`
falls back to `Font.system(...)` (sans for branded sans tokens, monospaced
for the mono token) at the same size and weight. Layout and ramp shape are
preserved; only the brand identity in glyph design is missing.

This directory is intentionally empty in the v0 commit because Satoshi's
licence terms must be verified per project before embedding. See the Phase 0
handoff session for the open licensing item.
