import XCTest
import Foundation
@testable import OrpheusCore

final class TerminalRepositoryTests: XCTestCase {

    private var db: Database!
    private var projectRepo: ProjectRepository!
    private var spaceRepo: SpaceRepository!
    private var repo: TerminalRepository!
    private var parentSpace: Space!

    override func setUp() async throws {
        db = try await Database(inMemory: ())
        projectRepo = ProjectRepository(database: db)
        spaceRepo = SpaceRepository(database: db)
        repo = TerminalRepository(database: db)

        let project = Project(name: "P", rootPath: "/tmp/p")
        try await projectRepo.create(project)
        parentSpace = Space(
            projectID: project.id,
            name: "S",
            layoutSpec: .canvas([]),
            ord: 0
        )
        try await spaceRepo.create(parentSpace)
    }

    private func makeTerm(cwd: String = "/tmp") -> Terminal {
        Terminal(spaceID: parentSpace.id, cwd: cwd)
    }

    // MARK: - CRUD

    func testCreateAndFetch() async throws {
        let t = makeTerm(cwd: "/home/user")
        try await repo.create(t)
        let fetched = try await repo.fetch(id: t.id)
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.cwd, "/home/user")
        XCTAssertEqual(fetched?.spaceID, parentSpace.id)
        XCTAssertEqual(fetched?.status, .stopped)
    }

    func testFetchAllReturnsAll() async throws {
        try await repo.create(makeTerm())
        try await repo.create(makeTerm())
        let all = try await repo.fetchAll()
        XCTAssertEqual(all.count, 2)
    }

    func testFetchNonexistentReturnsNil() async throws {
        let result = try await repo.fetch(id: TerminalID())
        XCTAssertNil(result)
    }

    func testUpdate() async throws {
        var t = makeTerm()
        try await repo.create(t)
        t.status = .running
        t.cwd = "/changed"
        t.command = "bash"
        try await repo.update(t)
        let fetched = try await repo.fetch(id: t.id)
        XCTAssertEqual(fetched?.status, .running)
        XCTAssertEqual(fetched?.cwd, "/changed")
        XCTAssertEqual(fetched?.command, "bash")
    }

    func testUpdateNonexistentThrows() async throws {
        await XCTAssertThrowsErrorAsync {
            try await self.repo.update(self.makeTerm())
        }
    }

    func testDelete() async throws {
        let t = makeTerm()
        try await repo.create(t)
        try await repo.delete(id: t.id)
        let result = try await repo.fetch(id: t.id)
        XCTAssertNil(result)
    }

    // MARK: - Nullable fields round-trip

    func testNullableFieldsRoundTrip() async throws {
        let sessionID = SessionID()
        let layoutPos = LayoutPosition.slot(index: 2)
        var t = makeTerm()
        t.claudeSessionID = sessionID
        t.layoutPosition = layoutPos
        t.command = "zsh"
        try await repo.create(t)
        let fetched = try await repo.fetch(id: t.id)
        XCTAssertEqual(fetched?.claudeSessionID, sessionID)
        XCTAssertEqual(fetched?.layoutPosition, layoutPos)
        XCTAssertEqual(fetched?.command, "zsh")
    }

    func testNilOptionalFieldsRoundTrip() async throws {
        let t = makeTerm()
        try await repo.create(t)
        let fetched = try await repo.fetch(id: t.id)
        XCTAssertNil(fetched?.claudeSessionID)
        XCTAssertNil(fetched?.layoutPosition)
        XCTAssertNil(fetched?.command)
    }

    // MARK: - fetchBySpace

    func testFetchBySpace() async throws {
        // Create a second space, add a terminal there.
        let project = Project(name: "P2", rootPath: "/tmp/p2")
        try await projectRepo.create(project)
        let otherSpace = Space(
            projectID: project.id, name: "Other", layoutSpec: .canvas([]), ord: 0
        )
        try await spaceRepo.create(otherSpace)
        let otherTerm = Terminal(spaceID: otherSpace.id, cwd: "/other")
        try await repo.create(otherTerm)

        // Add two terminals to parentSpace.
        try await repo.create(makeTerm())
        try await repo.create(makeTerm())

        let mine = try await repo.fetchBySpace(parentSpace.id)
        XCTAssertEqual(mine.count, 2)
        XCTAssertTrue(mine.allSatisfy { $0.spaceID == parentSpace.id })
    }

    // MARK: - All TerminalStatus values

    func testAllStatusesRoundTrip() async throws {
        for status in TerminalStatus.allCases {
            var t = makeTerm()
            t.status = status
            try await repo.create(t)
            let fetched = try await repo.fetch(id: t.id)
            XCTAssertEqual(fetched?.status, status)
            try await repo.delete(id: t.id)
        }
    }

    // MARK: - Observation

    func testObserveBySpaceEmitsOnChange() async throws {
        var t = makeTerm()
        try await repo.create(t)

        let stream = await repo.observeBySpace(parentSpace.id)
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first?.count, 1)

        t.status = .crashed
        try await repo.update(t)
        let second = await iterator.next()
        XCTAssertEqual(second?.first?.status, .crashed)
    }

    func testObserveAllEmitsOnChange() async throws {
        var t = makeTerm()
        try await repo.create(t)

        let stream = await repo.observeAll()
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first?.count, 1)

        t.status = .running
        try await repo.update(t)
        let second = await iterator.next()
        XCTAssertEqual(second?.first?.status, .running)
    }
}
