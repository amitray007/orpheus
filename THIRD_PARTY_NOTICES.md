# Third-Party Notices

Orpheus bundles or links the following third-party components. Their licenses and copyright notices are reproduced/identified below.

---

## Summary Table

| Component                          | What it is / where it ships                                                                                                                                  | License                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| libghostty                         | Prebuilt static library embedded in the native terminal addon (`packages/ghostty-surface`); repackaged from the Ghostty project via `Lakr233/libghostty-spm` | MIT                                                               |
| Ghostty color themes               | Theme files under `resources/ghostty/ghostty/themes/`; sourced from iTerm2-Color-Schemes                                                                     | MIT                                                               |
| JetBrains Mono (Nerd Font-patched) | Font embedded inside libghostty                                                                                                                              | SIL Open Font License 1.1 (OFL-1.1)                               |
| Geist Sans & Geist Mono            | Fonts from the `geist` npm package, bundled to `Resources/fonts`                                                                                             | SIL Open Font License 1.1 (OFL-1.1)                               |
| Ghostty shell-integration scripts  | Shell scripts under `resources/ghostty/ghostty/shell-integration/`; derived from the Kitty terminal                                                          | GPL-3.0                                                           |
| Electron                           | Application runtime bundling Chromium and Node.js                                                                                                            | MIT (Electron); BSD-3-Clause and others (Chromium); MIT (Node.js) |
| MIT-licensed npm dependencies      | `better-sqlite3`, `@phosphor-icons/react`, `@web-kits/audio`, `minidenticons`, `@electron-toolkit/utils`                                                     | MIT                                                               |

---

## 1. libghostty

**What it is:** A prebuilt static library (`vendor/GhosttyKit.xcframework`) embedded in the native terminal addon at `packages/ghostty-surface`. It is repackaged by the [`Lakr233/libghostty-spm`](https://github.com/Lakr233/libghostty-spm) project from the upstream [Ghostty](https://github.com/ghostty-org/ghostty) terminal emulator. This MIT grant also covers the bundled terminfo entry (`xterm-ghostty`) and the upstream source of the color themes.

**Copyright:** © 2024 Mitchell Hashimoto and Ghostty contributors

**License:** MIT

Full license text: https://opensource.org/license/mit

---

## 2. Ghostty Color Themes

**What it is:** Theme files shipped under `resources/ghostty/ghostty/themes/`. These originate from the [iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) project and are redistributed by Ghostty.

**Copyright:** © the iTerm2-Color-Schemes contributors

**License:** MIT

Full license text: https://opensource.org/license/mit

---

## 3. JetBrains Mono (Nerd Font-patched)

**What it is:** The JetBrains Mono typeface, patched with additional glyphs by the Nerd Fonts project, embedded inside the libghostty binary as the default terminal font.

**Copyright:**

- JetBrains Mono: © the JetBrains Mono Authors (JetBrains s.r.o.)
- Nerd Fonts glyph patches: © Ryan L McIntyre and the Nerd Fonts contributors

**License:** SIL Open Font License 1.1 (OFL-1.1)

Full license text: https://openfontlicense.org / https://scripts.sil.org/OFL

---

## 4. Geist Sans & Geist Mono

**What it is:** The Geist Sans and Geist Mono typefaces from the `geist` npm package, bundled to the application's `Resources/fonts` directory and used in the Orpheus renderer UI.

**Copyright:** © 2023 Vercel, Inc.

**License:** SIL Open Font License 1.1 (OFL-1.1)

Full license text: https://openfontlicense.org

---

## 5. Ghostty Shell-Integration Scripts

**What it is:** Shell integration scripts located under `resources/ghostty/ghostty/shell-integration/` (subdirectories: `bash/`, `zsh/`, `fish/`, `elvish/`, `nushell/`). These scripts are derived from the [Kitty terminal](https://github.com/kovidgoyal/kitty) project and are redistributed by Ghostty.

**License:** GNU General Public License v3.0 (GPL-3.0)

**Important GPL-3.0 notice:** These scripts are standalone programs that are sourced into the user's interactive shell at runtime. They are not linked into, compiled into, or incorporated as a library of Orpheus. Their distribution alongside Orpheus constitutes mere aggregation on storage media under GPLv3 §5, and does not place Orpheus itself under the GPL. The original file headers identifying the GPL-3.0 license are preserved in the distributed files.

**Aggregation, not a derivative work:** these files are shipped verbatim as standalone data files — executed by the user's own shell at runtime, not compiled, linked into, or otherwise incorporated into the Orpheus application binary. Because they are a "separate and independent work" bundled onto the same storage medium, GPLv3 §5's mere-aggregation clause applies: they remain under GPL-3.0 in their own right and do not extend GPL terms to the rest of Orpheus. Their complete source is available as shipped, verbatim, under `resources/ghostty/`.

Full license text: https://www.gnu.org/licenses/gpl-3.0.txt

---

## 6. Electron

**What it is:** The Electron application runtime, which bundles Chromium (rendering engine) and Node.js (JavaScript runtime). Electron's own bundled license files (e.g., `LICENSE.electron.txt`, `LICENSES.chromium.html`) ship inside the packaged application under `Orpheus.app/Contents/Frameworks/Electron Framework.framework/`.

**Copyright:**

- Electron: © 2013–present GitHub Inc. and contributors
- Chromium: © Google LLC and Chromium authors (BSD-3-Clause and additional licenses)
- Node.js: © Joyent, Inc. and Node.js contributors

**Licenses:**

- Electron: MIT
- Chromium: BSD-3-Clause and others (see `LICENSES.chromium.html` inside the packaged app)
- Node.js: MIT

Full license text:

- Electron / Node.js (MIT): https://opensource.org/license/mit
- Chromium licensing information: https://www.chromium.org/

---

## 7. MIT-Licensed npm Dependencies

The following runtime npm packages ship inside the packaged application and are all distributed under the MIT License.

| Package                   | Description                                   |
| ------------------------- | --------------------------------------------- |
| `better-sqlite3`          | Fast synchronous SQLite3 bindings for Node.js |
| `@phosphor-icons/react`   | Phosphor icon set for React                   |
| `@web-kits/audio`         | Web audio utilities                           |
| `minidenticons`           | Lightweight identicon generator               |
| `@electron-toolkit/utils` | Electron main-process utilities               |

**License for all of the above:** MIT

Full license text: https://opensource.org/license/mit

Each package's individual copyright holders and full license text are available in the respective `LICENSE` (or `LICENSE.md`) files within the installed package directories, or via https://www.npmjs.com/.
