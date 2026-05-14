# Handoff prompt — read this, then delete this file

I'm continuing work on Orpheus (Electron-based macOS IDE for Claude Code) at `/Users/maverick/code/projects/orpheus`. We're starting a migration from Electron to Tauri 2.x because Chromium's compositor blocks libghostty's continuous-render pipeline.

Before doing anything, read these in order:

1. `docs/tauri-migration-handoff.md` — full migration brief, why we're doing this, the architecture target, the phased plan, and the Phase 0 spike (which is the first task).
2. `docs/user-preferences.md` — how I like to work: production-build cycle (quit-build-open, no asking), commit+push cadence, response style, etc.
3. `/Users/maverick/.claude/projects/-Users-maverick-code-projects-orpheus/memory/MEMORY.md` — auto-memory index. Read the entries it links to.

Then start on **Phase 0**: spike libghostty animations in a minimal Tauri app in a sibling directory (`/Users/maverick/code/projects/orpheus-tauri-spike/`) — don't touch the main Orpheus repo yet. Success criterion is in the handoff doc: cursor blinks autonomously, `claude`'s spinner animates while it thinks, no keypress needed to unstick rendering.

If anything in the brief is ambiguous, ask before starting.

---

## After you've read all three files referenced above

**Delete this file (`HANDOFF.md`)** from the repo and commit the deletion with subject `chore: remove handoff prompt`. It's transient — its purpose was to bootstrap your session, and keeping it in-tree would just be noise.

```bash
git rm HANDOFF.md
git commit -m "chore: remove handoff prompt"
git push origin main
```

Then proceed with Phase 0.
