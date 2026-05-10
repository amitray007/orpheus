import os.log

enum OrpheusTerminalLogger {
    static let engine   = Logger(subsystem: "com.orpheus.terminal", category: "engine")
    static let surface  = Logger(subsystem: "com.orpheus.terminal", category: "surface")
    static let view     = Logger(subsystem: "com.orpheus.terminal", category: "view")
    static let theme    = Logger(subsystem: "com.orpheus.terminal", category: "theme")
    static let lifecycle = Logger(subsystem: "com.orpheus.terminal", category: "lifecycle")
}
