import Foundation

/// Constants that govern settings hot-reload behaviour.
///
/// The debounce window is locked at 250 ms per the Phase 1 Group 4 brief.
/// Macros editors (and many text editors) perform atomic saves that produce
/// multiple rapid FSEvents in quick succession; coalescing them into a single
/// reload after `settingsDebounceInterval` avoids spurious re-emissions.
public enum SettingsConstants {
    /// How long `SettingsWatcher` waits after the last filesystem event
    /// before re-loading and emitting a new merged settings value.
    ///
    /// Locked at 250 ms. Do not lower without also running the
    /// `SettingsWatcherTests` to confirm the timing tests still pass.
    public static let settingsDebounceInterval: TimeInterval = 0.250
}
