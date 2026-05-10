import XCTest
@testable import Orpheus
import OrpheusCore

@MainActor
final class DashboardViewModelTests: XCTestCase {

    private func makeDB() async throws -> OrpheusCore.Database {
        try await OrpheusCore.Database(inMemory: ())
    }

    /// `isLoading` flips to false on first emission from project repository.
    func testIsLoadingFlipsOnFirstEmission() async throws {
        let db = try await makeDB()
        let vm = DashboardViewModel(
            projectRepository: ProjectRepository(database: db),
            sessionRegistry: SessionRegistry(
                rootURL: FileManager.default.homeDirectoryForCurrentUser
            )
        )
        XCTAssertTrue(vm.isLoading, "Should start in loading state")
        vm.start()

        // Give observation time to emit the initial (empty) snapshot
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(vm.isLoading, "Should not be loading after first emission")
    }

    /// `projects` reflects what's in the repository.
    func testProjectsReflectsRepository() async throws {
        let db = try await makeDB()
        let repo = ProjectRepository(database: db)
        let project = Project(name: "myproj", rootPath: "/tmp/myproj")
        try await repo.create(project)

        let vm = DashboardViewModel(
            projectRepository: repo,
            sessionRegistry: SessionRegistry(
                rootURL: FileManager.default.homeDirectoryForCurrentUser
            )
        )
        vm.start()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(vm.projects.count, 1)
        XCTAssertEqual(vm.projects.first?.name, "myproj")
    }
}
