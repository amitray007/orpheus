/**
 * Pure helper: strips a single trailing `//# sourceMappingURL=...` comment
 * line from a .js file's contents, if present. Extracted out of
 * scripts/package-tui-assets.mjs into its own zero-side-effect module so
 * scripts/verify-tmux-host.ts can import and unit-test it directly, without
 * re-running that script's top-level staging pipeline (which does file I/O
 * and process.exit(1) on missing deps — not something a test should trigger
 * as an import side effect).
 *
 * See package-tui-assets.mjs's own "Step 3" comment for WHY this exists: the
 * vendored @opentui/core (and its flat runtime deps) bundle keeps a
 * sourceMappingURL comment pointing at a .map file that staging deliberately
 * never copies (devtools-only, ~5.4MB dead weight) — left in place, Bun's
 * runtime source-map loader logs a `Could not decode sourcemap …
 * UnsupportedFormat` warning straight over the TUI's rendered output on
 * first load of that module.
 */

const SOURCE_MAPPING_COMMENT = /\r?\n?\/\/# sourceMappingURL=[^\r\n]*\r?\n?$/u

/**
 * @param {string} contents
 * @returns {string}
 */
export function stripTrailingSourceMappingComment(contents) {
  return contents.replace(SOURCE_MAPPING_COMMENT, '\n')
}
