//! Orpheus terminal addon, Phase 1 (scaffold).
//!
//! This crate is the future replacement for `packages/ghostty-native/addon.mm`.
//! Phase 1 just gets the build working end-to-end: `bun run build` produces a
//! `.node` binary that Node can `require()`, and `ping()` returns a string.
//! Subsequent phases will wrap `libghostty-vt::Terminal` here.

#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

#[napi]
pub fn ping() -> String {
  "pong".to_string()
}

#[napi]
pub fn add_numbers(a: i32, b: i32) -> i32 {
  a + b
}
