import XCTest
import Foundation
@testable import OrpheusCore

final class ProjectRepositoryTests: XCTestCase {

    private var db: Database!
    private var repo: ProjectRepository!

    override func setUp() async throws {
        db = try await Database(inMemory: ())
        repo = ProjectRepository(database: db)
    }

    // MARK: - CRUD

    func testCreateAndFetch() async throws {
        let project = Project(
            name: "Alpha",
            rootPath: "/tmp/alpha",
            tags: ["swift", "ios"]
        )
        try await repo.create(project)
        let fetched = try await repo.fetch(id: project.id)
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.name, "Alpha")
        XCTAssertEqual(fetched?.rootPath, "/tmp/alpha")
        XCTAssertEqual(fetched?.tags, ["swift", "ios"])
        XCTAssertEqual(fetched?.lifecycleState, .active)
    }

    func testFetchAllReturnsAll() async throws {
        try await repo.create(Project(name: "A", rootPath: "/tmp/a"))
        try await repo.create(Project(name: "B", rootPath: "/tmp/b"))
        let all = try await repo.fetchAll()
        XCTAssertEqual(all.count, 2)
    }

    func testFetchNonexistentReturnsNil() async throws {
        let result = try await repo.fetch(id: ProjectID())
        XCTAssertNil(result)
    }

    func testUpdate() async throws {
        var project = Project(name: "Before", rootPath: "/tmp/before")
        try await repo.create(project)
        project.name = "After"
        project.lifecycleState = .archived
        project.tags = ["updated"]
        project.updatedAt = Date()
        try await repo.update(project)
        let fetched = try await repo.fetch(id: project.id)
        XCTAssertEqual(fetched?.name, "After")
        XCTAssertEqual(fetched?.lifecycleState, .archived)
        XCTAssertEqual(fetched?.tags, ["updated"])
    }

    func testUpdateNonexistentThrowsNotFound() async throws {
        let phantom = Project(name: "Ghost", rootPath: "/tmp/ghost")
        await XCTAssertThrowsErrorAsync {
            try await self.repo.update(phantom)
        }
    }

    func testDelete() async throws {
        let project = Project(name: "Delete Me", rootPath: "/tmp/del")
        try await repo.create(project)
        try await repo.delete(id: project.id)
        let fetched = try await repo.fetch(id: project.id)
        XCTAssertNil(fetched)
    }

    func testDeleteNonexistentIsNoop() async throws {
        // Should not throw.
        try await repo.delete(id: ProjectID())
    }

    // MARK: - Lifecycle state round-trip

    func testAllLifecycleStatesRoundTrip() async throws {
        for state in LifecycleState.allCases {
            let p = Project(
                id: ProjectID(),
                name: "State test",
                rootPath: "/tmp/state",
                lifecycleState: state
            )
            try await repo.create(p)
            let fetched = try await repo.fetch(id: p.id)
            XCTAssertEqual(fetched?.lifecycleState, state)
            try await repo.delete(id: p.id)
        }
    }

    // MARK: - Observation

    func testObserveAllEmitsOnChange() async throws {
        var project = Project(name: "Watched", rootPath: "/tmp/w")
        try await repo.create(project)

        let stream = await repo.observeAll()
        var iterator = stream.makeAsyncIterator()

        // First emission is the current snapshot.
        let first = await iterator.next()
        XCTAssertEqual(first?.count, 1)

        // Mutate and verify a second emission arrives.
        project.name = "Updated"
        project.updatedAt = Date()
        try await repo.update(project)

        let second = await iterator.next()
        XCTAssertEqual(second?.first?.name, "Updated")
    }
}
