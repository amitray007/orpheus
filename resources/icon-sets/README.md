# Orpheus icon packs

This directory is the catalog for selectable Orpheus icon packs. Each pack is a
direct child directory with a valid `manifest.json` and a complete asset tree.
Directories without a manifest that validates against
[`pack.schema.json`](pack.schema.json) are ignored.

The catalog is intentionally data-only for now. Nothing here changes the current
build icons or enables the Settings picker by itself.

## Pack contract

Each pack has:

- a stable lowercase `id` that Settings can persist;
- a human-readable name, description, and semantic version;
- `production`, `development`, and `nightly` variants;
- app, menu-bar, macOS template, and Settings-preview assets for every variant;
- a `worktree` mode fallback, currently required to resolve to `development`.

Manifest asset paths are relative to the pack directory. The schema allows nested
paths but rejects absolute paths and traversal segments such as `..`. Discovery
must still resolve every path and verify that the result remains inside the pack
root before loading it.

## Required layout

Every build-mode directory uses the same structure:

```text
<pack>/
├── manifest.json
├── production/
│   ├── app/
│   │   ├── app.svg
│   │   ├── app.png
│   │   ├── app.iconset/
│   │   └── app.icns
│   ├── menubar/
│   │   ├── icon.svg
│   │   ├── icon.png
│   │   ├── icon@2x.png
│   │   ├── iconTemplate.svg
│   │   ├── iconTemplate.png
│   │   └── iconTemplate@2x.png
│   └── previews/
│       ├── preview.png
│       └── preview@2x.png
├── development/
│   └── app/, menubar/, previews/
└── nightly/
    └── app/, menubar/, previews/
```

Each `app.iconset` contains the standard 16, 32, 128, 256, and 512 point images
at 1× and 2×.

## Rebuilding derived assets

Edit the source SVGs, then regenerate one complete pack offline from its
manifest:

```bash
node scripts/build-icon-pack.mjs dreamer
```

The generator validates the pack boundary and source canvases, then writes the
1024px runtime icon, all 10 macOS iconset frames, ICNS, 256px/512px Settings
previews, 32px/64px colored menu-bar images, and 18px/36px monochrome template
images. It requires the repository's existing `sharp` dependency and macOS
`iconutil`. On macOS versions where `iconutil` rejects a valid legacy iconset,
the generator falls back to electron-builder's already-installed offline icon
converter.

## Asset roles

| Asset                       | Consumer                                             |
| --------------------------- | ---------------------------------------------------- |
| `app/app.svg`               | Editable source master                               |
| `app/app.png`               | Runtime app/Dock icon via Electron `nativeImage`     |
| `app/app.iconset/`          | Standard macOS source frames for icon compilation    |
| `app/app.icns`              | Packaged macOS application icon                      |
| `menubar/icon*.png`         | Colored menu-bar artwork at 32px and 64px            |
| `menubar/iconTemplate*.png` | Template artwork at 18px and 36px for native tinting |
| `previews/preview*.png`     | Settings picker previews at 256px and 512px          |

## Future discovery and runtime use

A future icon-pack service can enumerate immediate child directories, validate
each manifest and referenced asset, reject duplicate IDs, and expose valid packs
to Settings. Settings should persist only the pack `id`, not an absolute path or
version.

At runtime, resolve the current app mode to a manifest variant:

| App mode    | Variant                  |
| ----------- | ------------------------ |
| Production  | `production`             |
| Development | `development`            |
| Nightly     | `nightly`                |
| Worktree    | `modeFallbacks.worktree` |

The catalog is intentionally data-only for now. Nothing here changes current
build icons or enables the Settings picker by itself.

The Dreamer pack is available at [`dreamer`](dreamer/manifest.json).
