import Foundation

public struct Terminal: Codable, Sendable, Hashable {
    public let id: TerminalID
    public var spaceID: SpaceID
    public var cwd: String
    public var command: String?
    public var status: TerminalStatus
    public var claudeSessionID: SessionID?
    public var layoutPosition: LayoutPosition?
    public var createdAt: Date

    public init(
        id: TerminalID = TerminalID(),
        spaceID: SpaceID,
        cwd: String,
        command: String? = nil,
        status: TerminalStatus = .stopped,
        claudeSessionID: SessionID? = nil,
        layoutPosition: LayoutPosition? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.spaceID = spaceID
        self.cwd = cwd
        self.command = command
        self.status = status
        self.claudeSessionID = claudeSessionID
        self.layoutPosition = layoutPosition
        self.createdAt = createdAt
    }
}
