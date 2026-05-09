import XCTest
import Foundation
@testable import OrpheusCore

final class SpaceRepositoryTests: XCTestCase {

    private var db: Database!
    private var projectRepo: ProjectRepository!
    private var repo: SpaceRepository!
    private var parentProject: Project!

    override func setUp() async throws {
        db = try await Database(inMemory: ())
        projectRepo = ProjectRepository(database: db)
        repo = SpaceRepository(database: db)

        parentProject = Project(name: "Parent", rootPath: "/tmp/parent")
        try await projectRepo.create(parentProject)
    }

    private func makeSpace(ord: Int = 0) -> Space {
        Space(
            projectID: parentProject.id,
            name: "Space \(ord)",
            layoutSpec: .canvas([]),
            ord: ord
        )
    }

    // MARK: - CRUD

    func testCreateAndFetch() async throws {
        let space = makeSpace()
        try await repo.create(space)
        let fetched = try await repo.fetch(id: space.id)
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.name, space.name)
        XCTAssertEqual(fetched?.projectID, parentProject.id)
        XCTAssertEqual(fetched?.ord, 0)
    }

    func testFetchAllReturnsAll() async throws {
        try await repo.create(makeSpace(ord: 0))
        try await repo.create(makeSpace(ord: 1))
        let all = try await repo.fetchAll()
        XCTAssertEqual(all.count, 2)
    }

    func testFetchNonexistentReturnsNil() async throws {
        let result = try await repo.fetch(id: SpaceID())
        XCTAssertNil(result)
    }

    func testUpdate() async throws {
        var space = makeSpace()
        try await repo.create(space)
        space.name = "Renamed"
        space.lifecycleState = .paused
        space.updatedAt = Date()
        try await repo.update(space)
        let fetched = try await repo.fetch(id: space.id)
        XCTAssertEqual(fetched?.name, "Renamed")
        XCTAssertEqual(fetched?.lifecycleState, .paused)
    }

    func testUpdateNonexistentThrows() async throws {
        let phantom = makeSpace()
        await XCTAssertThrowsErrorAsync {
            try await self.repo.update(phantom)
        }
    }

    func testDelete() async throws {
        let space = makeSpace()
        try await repo.create(space)
        try await repo.delete(id: space.id)
        let result = try await repo.fetch(id: space.id)
        XCTAssertNil(result)
    }

    // MARK: - fetchByProject

    func testFetchByProject() async throws {
        // Create a second project and add a space to it.
        let otherProject = Project(name: "Other", rootPath: "/tmp/other")
        try await projectRepo.create(otherProject)
        let otherSpace = Space(
            projectID: otherProject.id,
            name: "Other Space",
            layoutSpec: .canvas([]),
            ord: 0
        )
        try await repo.create(otherSpace)

        // Spaces for parentProject.
        try await repo.create(makeSpace(ord: 0))
        try await repo.create(makeSpace(ord: 1))

        let mine = try await repo.fetchByProject(parentProject.id)
        XCTAssertEqual(mine.count, 2)
        XCTAssertTrue(mine.allSatisfy { $0.projectID == parentProject.id })
    }

    func testFetchByProjectReturnsOrderedByOrd() async throws {
        try await repo.create(makeSpace(ord: 2))
        try await repo.create(makeSpace(ord: 0))
        try await repo.create(makeSpace(ord: 1))
        let spaces = try await repo.fetchByProject(parentProject.id)
        let ords = spaces.map(\.ord)
        XCTAssertEqual(ords, ords.sorted())
    }

    // MARK: - Cascade delete

    func testCascadeDeleteFromProject() async throws {
        try await repo.create(makeSpace(ord: 0))
        try await repo.create(makeSpace(ord: 1))
        try await projectRepo.delete(id: parentProject.id)
        let remaining = try await repo.fetchAll()
        XCTAssertTrue(remaining.isEmpty)
    }

    // MARK: - LayoutSpec round-trip

    func testSplitLayoutSpecRoundTrips() async throws {
        let tid1 = TerminalID()
        let tid2 = TerminalID()
        let layout = LayoutSpec.split(
            axis: .horizontal,
            lhs: .leaf(tid1),
            rhs: .leaf(tid2),
            fraction: 0.5
        )
        let space = Space(projectID: parentProject.id, name: "Split", layoutSpec: layout, ord: 0)
        try await repo.create(space)
        let fetched = try await repo.fetch(id: space.id)
        XCTAssertEqual(fetched?.layoutSpec, layout)
    }

    // MARK: - Observation

    func testObserveByProjectEmitsOnChange() async throws {
        var space = makeSpace()
        try await repo.create(space)

        let stream = await repo.observeByProject(parentProject.id)
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        XCTAssertEqual(first?.count, 1)

        space.name = "Changed"
        space.updatedAt = Date()
        try await repo.update(space)

        let second = await iterator.next()
        XCTAssertEqual(second?.first?.name, "Changed")
    }
}
