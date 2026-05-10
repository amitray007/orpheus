import XCTest
@testable import Orpheus
import OrpheusCore

@MainActor
final class OnboardingViewModelTests: XCTestCase {

    private func makeDB() async throws -> OrpheusCore.Database {
        try await OrpheusCore.Database(inMemory: ())
    }

    private func makeState(db: OrpheusCore.Database) -> AppState {
        let state = AppState(
            database: db,
            projectRepository: ProjectRepository(database: db),
            spaceRepository: SpaceRepository(database: db),
            terminalRepository: TerminalRepository(database: db),
            appStateRepository: AppStateRepository(database: db),
            sessionRegistry: SessionRegistry(
                rootURL: FileManager.default.homeDirectoryForCurrentUser
            )
        )
        state.wireOnboardingViewModel()
        return state
    }

    /// After `createProjectAndDefaultSpace`, a project + space exist, and the
    /// onboarding_seen flag is true.
    func testCreateProjectSetsOnboardingFlag() async throws {
        let db = try await makeDB()
        let state = makeState(db: db)
        let vm = state.onboardingViewModel

        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("orpheus-onboarding-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let spaceID = try await vm.createProjectAndDefaultSpace(at: tmpDir)

        // Check project exists
        let projects = try await state.projectRepository.fetchAll()
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects.first?.name, tmpDir.lastPathComponent)

        // Check Default Space exists
        let spaces = try await state.spaceRepository.fetchByProject(projects.first!.id)
        XCTAssertEqual(spaces.count, 1)
        XCTAssertEqual(spaces.first?.id, spaceID)
        XCTAssertEqual(spaces.first?.name, "Default Space")

        // Mark onboarding seen
        try await vm.markOnboardingSeen()
        let flag = try await state.appStateRepository.get(key: "onboarding_seen")
        XCTAssertEqual(flag, "true")
    }

    /// Screen transitions to `.emptySpace` after onboarding completion.
    func testOnboardingTransitionsToEmptySpace() async throws {
        let db = try await makeDB()
        let state = makeState(db: db)
        let vm = state.onboardingViewModel

        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("orpheus-transition-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let spaceID = try await vm.createProjectAndDefaultSpace(at: tmpDir)
        try await vm.markOnboardingSeen()
        state.currentScreen = .emptySpace(spaceID)

        if case .emptySpace(let sid) = state.currentScreen {
            XCTAssertEqual(sid, spaceID)
        } else {
            XCTFail("Expected .emptySpace screen, got \(state.currentScreen)")
        }
    }
}
