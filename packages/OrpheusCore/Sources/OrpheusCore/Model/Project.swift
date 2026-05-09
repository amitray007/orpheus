import Foundation

public struct Project: Codable, Sendable, Hashable {
    public let id: ProjectID
    public var name: String
    public var rootPath: String
    public var lifecycleState: LifecycleState
    public var tags: [String]
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: ProjectID = ProjectID(),
        name: String,
        rootPath: String,
        lifecycleState: LifecycleState = .active,
        tags: [String] = [],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.rootPath = rootPath
        self.lifecycleState = lifecycleState
        self.tags = tags
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
