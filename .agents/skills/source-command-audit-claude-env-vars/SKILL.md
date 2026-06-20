---
name: 'source-command-audit-claude-env-vars'
description: "Audit Orpheus's Settings UI against the latest Codex documentation. Reports new env vars / settings keys / CLI flags that aren't yet wired, deferred items that are now common enough to wire, broken wired-claims, and an updated snapshot. Optionally scaffolds the wiring when asked."
---

# source-command-audit-claude-env-vars

Use this skill when the user asks to run the migrated source command `audit-claude-env-vars`.

## Command Template

Invoke the `audit-Codex-env-vars` subagent to audit Orpheus against the latest Codex docs.

Default behavior: report-only. The subagent fetches:

- `https://code.Codex.com/docs/en/env-vars.md` (primary)
- `https://code.Codex.com/docs/en/settings.md`
- `https://code.Codex.com/docs/en/claude_code_docs_map.md`
- `Codex --help` for CLI flags

Diffs against `.Codex/snapshots/env-vars.json` and the actual emissions in `src/main/claudeSettings.ts` + `src/main/claudeAuth.ts`. Produces a short report of new / deferred / removed / broken-wired items, plus a suggested next chunk to ship.

If your prompt includes "wire" / "scaffold" / "ship", the subagent will also scaffold the schema + types + emission + UI for new vars, then run `bun run typecheck`. It won't commit — you commit after reviewing.

To run it: just type `/audit-Codex-env-vars` (no args). Add a category hint like `/audit-Codex-env-vars display` to focus on a specific section.
