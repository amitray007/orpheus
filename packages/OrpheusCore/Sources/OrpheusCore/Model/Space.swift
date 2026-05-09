import Foundation

public struct Space: Codable, Sendable, Hashable {
    public let id: SpaceID
    public var projectID: ProjectID
    public var name: String
    public var description: String?
    public var layoutSpec: LayoutSpec
    public var ord: Int
    public var lifecycleState: LifecycleState
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: SpaceID = SpaceID(),
        projectID: ProjectID,
        name: String,
        description: String? = nil,
        layoutSpec: LayoutSpec,
        ord: Int = 0,
        lifecycleState: LifecycleState = .active,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.projectID = projectID
        self.name = name
        self.description = description
        self.layoutSpec = layoutSpec
        self.ord = ord
        self.lifecycleState = lifecycleState
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
