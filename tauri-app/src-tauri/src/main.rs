// Prevents the additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    orpheus_tauri_spike_lib::run();
}
