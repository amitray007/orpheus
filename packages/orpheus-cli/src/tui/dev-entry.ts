/**
 * tui/dev-entry.ts — source-run entry for the picker, used ONLY by
 * scripts/tui-dev.sh (`bun run tui:dev`). Not bundled, not shipped.
 *
 * The packaged path reaches runTui() through commands/tui.ts, which
 * dynamic-import()s the esbuild-produced dist/tui.mjs. That indirection
 * exists so the CJS CLI bundle can load an ESM one — irrelevant when running
 * TypeScript directly under Bun, so this file just calls runTui().
 *
 * Keep it a thin call. Anything that belongs to the picker itself belongs in
 * entry.ts, so the source-run and packaged paths cannot drift.
 */

import { runTui } from './entry.js'

await runTui({})
