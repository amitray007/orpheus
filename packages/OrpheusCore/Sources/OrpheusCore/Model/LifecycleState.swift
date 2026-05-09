public enum LifecycleState: String, Codable, Sendable, CaseIterable {
    case active
    case paused
    case archived
    case pinned
}
