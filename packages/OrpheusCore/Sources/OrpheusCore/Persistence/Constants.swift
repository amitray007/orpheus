/// Scrollback ring-buffer constants.
///
/// These values establish an upper bound on how much terminal output is
/// retained in SQLite.  A single terminal may store at most
/// `scrollbackRingLimit` chunks of `scrollbackChunkSize` bytes each,
/// giving a ceiling of ~16 MiB per terminal.
public enum ScrollbackConstants {
    /// Maximum size (in bytes) of one scrollback chunk before a flush is
    /// triggered and a new `terminal_scrollback` row is written.
    public static let scrollbackChunkSize: Int = 64 * 1024   // 64 KiB

    /// Maximum number of chunks retained per terminal.  Oldest chunks are
    /// evicted when this limit is exceeded.
    public static let scrollbackRingLimit: Int = 256

    /// Maximum interval (in seconds) between automatic flushes of pending
    /// scrollback bytes, regardless of buffer fill level.
    public static let scrollbackFlushInterval: Double = 0.250  // 250 ms
}
