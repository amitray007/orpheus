public enum TerminalStatus: String, Codable, Sendable, CaseIterable {
    case running
    case stopped
    case crashed
    case detached
}
