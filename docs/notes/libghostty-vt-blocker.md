# libghostty-vt port — toolchain blocker

**Status:** Phase 1 (Rust addon scaffold) shipped in `3ff51c0`. Phase 2 (wrap `libghostty-vt::Terminal`) blocked on toolchain.

## What we tried

Added `libghostty-vt = { git = "https://github.com/Uzaaft/libghostty-rs", branch = "master" }` to `packages/terminal-vt-native/Cargo.toml`. Walked through three sequential blockers:

1. **Rust version.** Upstream crate requires Rust ≥ 1.90. Resolved by `rustup default stable` (jumped to 1.95.0).

2. **Zig version.** `libghostty-vt-sys/build.rs` invokes `zig build` which builds Ghostty source from scratch. Ghostty pins to Zig 0.15.2 (`build.zig` errors out on 0.16+). Resolved by downloading Zig 0.15.2 into `vendor/zig-0.15/` and exporting `PATH=vendor/zig-0.15:$PATH`.

3. **macOS SDK linker errors (the real blocker).** Zig 0.15.2 fails to link its own build runner against the macOS 26.5 SDK. Unresolved symbols at the Zig-link step:

   ```
   _isatty
   _malloc_size
   _posix_memalign
   _realpath$DARWIN_EXTSN
   _sigaction
   _sigemptyset
   _sysctlbyname
   _waitpid
   ```

   These are all libc/libSystem symbols. Setting `SDKROOT=$(xcrun --sdk macosx --show-sdk-path)` does not help — same errors. The `$DARWIN_EXTSN` suffix on `realpath` is a macOS symbol-versioning hint that Zig 0.15.2's bundled headers/stubs don't carry for macOS 26.

   This is a Zig-vs-recent-macOS-SDK incompatibility, not something fixable from our build.rs. Cargo's `cargo:rustc-link-lib=System` / `c++` / framework directives only affect OUR final cdylib link, not Zig's intermediate static lib build.

## Why this matters

Our `Cargo.toml` had to comment out the dep and roll back the link-directive changes to keep `bun run build:native` green. The Rust scaffold from Phase 1 still works; we just can't pull in the VT crate.

## Paths forward

### A. Wait for upstream (lowest effort, indeterminate timeline)

- Either Zig 0.15.3+ ships with macOS 26 SDK fixes
- Or `libghostty-rs` updates to support Zig 0.16
- Track: github.com/ziglang/zig releases, github.com/Uzaaft/libghostty-rs commits

### B. Vendor a prebuilt `libghostty-vt.a` (medium effort)

- Build the `.a` on a Linux/older-macOS machine where Zig 0.15.2 + SDK align
- Vendor the static lib + ghostty.h header into our repo
- Skip `libghostty-vt-sys`'s build.rs entirely; write our own thin FFI bindings
- Estimated effort: 1–2 days
- Maintenance: re-vendor when bumping Ghostty version

### C. Pivot to xterm.js (recommended right now)

- 1–2 days of focused work to ship a working terminal stack
- Title, clipboard, drag/drop, overlays all work out of the box
- Lose Metal rendering, gain reliability + much smaller code surface
- The libghostty-vt port stays as a future option once toolchain blockers clear

### D. Stay with current libghostty + accept missing titles

- No work, no progress on the title issue
- Other terminal functionality works fine

## Recommendation

**Path C** (xterm.js). The toolchain blocker is real, indeterminate, and outside our control. The product cost of two more weeks of fighting Zig vs the comparatively-small cost of WebGL-rendered xterm.js is unfavorable. We can revisit the libghostty-vt port any time the toolchain catches up — Phase 1's scaffold is reusable.

If you want path B, that's also reasonable — it's bounded work, but the maintenance cost of vendoring + re-vendoring `.a` files every Ghostty release is real.
