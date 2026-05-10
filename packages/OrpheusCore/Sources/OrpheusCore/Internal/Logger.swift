import os.log

/// Centralised `os.Logger` instances for OrpheusCore.
///
/// Each subsystem category maps to a logical layer of the package.
/// Other groups add their own `static let` properties here rather
/// than creating ad-hoc Logger instances.
internal enum OrpheusLogger {
    internal static let persistence = Logger(
        subsystem: "com.orpheus.core",
        category: "persistence"
    )
    internal static let settings = Logger(
        subsystem: "com.orpheus.core",
        category: "settings"
    )
    internal static let sessions = Logger(
        subsystem: "com.orpheus.core",
        category: "sessions"
    )
    internal static let subprocess = Logger(
        subsystem: "com.orpheus.core",
        category: "subprocess"
    )
}
