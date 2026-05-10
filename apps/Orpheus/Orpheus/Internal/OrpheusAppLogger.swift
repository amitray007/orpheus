import OSLog

/// App-level logging. All log calls in `apps/Orpheus/` go through this
/// namespace. The print statement is forbidden; see DisciplineLintTests.
enum OrpheusAppLogger {
    static let app       = Logger(subsystem: "com.orpheus.app", category: "app")
    static let sidebar   = Logger(subsystem: "com.orpheus.app", category: "sidebar")
    static let dashboard = Logger(subsystem: "com.orpheus.app", category: "dashboard")
    static let onboarding = Logger(subsystem: "com.orpheus.app", category: "onboarding")
    static let errors    = Logger(subsystem: "com.orpheus.app", category: "errors")
}
