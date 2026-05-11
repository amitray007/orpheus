# Libraries — Approved & Considered

Reference for third-party tools approved or considered for Orpheus. **Not installed yet** — add at the point of actual use, not preemptively. Each entry notes status (considered / preferred / locked / rejected) and a one-line reason.

---

## Audio

- **@web-kits/audio** — `npx @web-kits/audio add`
  Audio playback (completion sounds, voice features, notification chimes). Nominated 2026-05-11. Status: **considered** — install at first audio need.

---

## Skeleton placeholders

- **boneyard-js** ✅ — `npm install boneyard-js`
  Use directly when skeleton / loading-placeholder UI surfaces. Don't roll our own — user explicitly chose this to avoid wasting time on skeleton primitives. Status: **locked** 2026-05-11.

---

## Unicode loading spinners

v0 leans toward **#1 + #3**. **#2** held in reserve (use only if a React drop-in becomes more pragmatic than copying generated markup).

1. ✅ **dotmatrix.zzzzshawn.cloud** — https://dotmatrix.zzzzshawn.cloud/
   Generator for unicode dot-matrix loaders. Status: **preferred** 2026-05-11.
2. **@dot-loaders/react** — `npm install @dot-loaders/react`
   Drop-in React components. Status: **reserve**.
3. ✅ **loading-ui.com** — https://loading-ui.com/
   Gallery of loading patterns. Status: **preferred** 2026-05-11.

---

## Maintenance

Add new libraries here as they come up. Each entry: name + install/url + one-line use case + status + date. Once we adopt something into the codebase, the entry should still stay (with a "Status: in use" note) — this doc is the running record of design-level dependency choices, not just future intentions.
