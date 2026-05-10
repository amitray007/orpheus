import XCTest
@testable import Orpheus
import OrpheusCore

@MainActor
final class SidebarViewModelTests: XCTestCase {

    // MARK: - Helpers

    private func makeDB() async throws -> OrpheusCore.Database {
        try await OrpheusCore.Database(inMemory: ())
    }

    @MainActor
    private func makeVM(db: OrpheusCore.Database) -> SidebarViewModel {
        SidebarViewModel(
            projectRepository: ProjectRepository(database: db),
            spaceRepository: SpaceRepository(database: db),
            terminalRepository: TerminalRepository(database: db)
        )
    }

    // MARK: - Tests

    /// `projects` reflects repository emissions in order.
    func testProjectsReflectRepositoryEmissions() async throws {
        let db = try await makeDB()
        let repo = ProjectRepository(database: db)
        let vm = makeVM(db: db)
        vm.start()

        let p1 = Project(name: "alpha", rootPath: "/tmp/alpha")
        let p2 = Project(name: "beta",  rootPath: "/tmp/beta")
        try await repo.create(p1)
        try await repo.create(p2)

        // Give the observation a moment to propagate
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(vm.projects.count, 2)
        XCTAssertEqual(vm.projects[0].name, "alpha")
        XCTAssertEqual(vm.projects[1].name, "beta")
    }

    /// Pinned projects appear in `pinnedProjects`, unpinned in `unpinnedProjects`.
    func testPinnedVsUnpinnedPartition() async throws {
        let db = try await makeDB()
        let repo = ProjectRepository(database: db)
        let vm = makeVM(db: db)
        vm.start()

        let active = Project(name: "active", rootPath: "/tmp/active", lifecycleState: .active)
        let pinned = Project(name: "pinned", rootPath: "/tmp/pinned", lifecycleState: .pinned)
        try await repo.create(active)
        try await repo.create(pinned)

        try await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(vm.pinnedProjects.count, 1)
        XCTAssertEqual(vm.pinnedProjects[0].name, "pinned")
        XCTAssertEqual(vm.unpinnedProjects.count, 1)
        XCTAssertEqual(vm.unpinnedProjects[0].name, "active")
    }

    /// Logo glyph: `.git` directory → git project; otherwise → false.
    func testLogoGlyphDerivation() async throws {
        let db = try await makeDB()
        let vm = makeVM(db: db)

        // Non-git project: /tmp is not a git repo
        let nonGit = Project(name: "nongit", rootPath: "/tmp")
        XCTAssertFalse(vm.isGitProject(nonGit))

        // Fake git project: create a temp .git dir
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("orpheus-test-\(UUID().uuidString)")
        let gitDir = tmpDir.appendingPathComponent(".git")
        try FileManager.default.createDirectory(at: gitDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let gitProject = Project(name: "git", rootPath: tmpDir.path)
        XCTAssertTrue(vm.isGitProject(gitProject))
    }

    /// Expanding a project triggers space subscription; collapsing tears it down.
    func testExpandCollapseWiresSpaceSubscription() async throws {
        let db = try await makeDB()
        let projectRepo = ProjectRepository(database: db)
        let spaceRepo = SpaceRepository(database: db)
        let vm = makeVM(db: db)
        vm.start()

        let project = Project(name: "proj", rootPath: "/tmp/proj")
        try await projectRepo.create(project)
        let space = Space(
            projectID: project.id,
            name: "Default Space",
            layoutSpec: .canvas([]),
            ord: 0
        )
        try await spaceRepo.create(space)

        // Expand
        vm.expand(project.id)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(vm.expandedProjects.contains(project.id))
        XCTAssertNotNil(vm.spacesByProject[project.id])
        XCTAssertEqual(vm.spacesByProject[project.id]?.count, 1)

        // Collapse
        vm.collapse(project.id)
        XCTAssertFalse(vm.expandedProjects.contains(project.id))
        XCTAssertNil(vm.spacesByProject[project.id])
    }
}
