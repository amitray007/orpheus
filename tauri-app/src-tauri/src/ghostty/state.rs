use once_cell::sync::OnceCell;
use std::sync::Mutex;
use super::ffi::{ghostty_app_t, ghostty_surface_t};

pub struct GlobalState {
    pub app: ghostty_app_t,
}

// SAFETY: ghostty_app_t is an opaque pointer; access is serialized by the Mutex.
unsafe impl Send for GlobalState {}
unsafe impl Sync for GlobalState {}

pub struct SurfaceState {
    pub surface: ghostty_surface_t,
    // NSView raw pointer stored as usize to avoid Send issues; accessed on main thread only.
    pub nsview: usize,
}

unsafe impl Send for SurfaceState {}
unsafe impl Sync for SurfaceState {}

pub static GLOBAL: OnceCell<Mutex<GlobalState>> = OnceCell::new();
pub static SURFACE: OnceCell<Mutex<SurfaceState>> = OnceCell::new();
