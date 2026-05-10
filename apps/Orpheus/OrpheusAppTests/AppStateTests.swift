import XCTest
@testable import Orpheus
import OrpheusCore

@MainActor
final class AppStateTests: XCTestCase {

    // MARK: - Helpers

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

    // MARK: - Launch decision tree tests

    /// Empty DB + `onboarding_seen` unset → `.onboarding`
    func testEmptyDBNoOnboardingFlag_ShowsOnboarding() async throws {
        let db = try await makeDB()
        let state = makeState(db: db)
        await state.determineLaunchScreen()
        XCTAssertEqual(state.currentScreen, .onboarding)
    }

    /// Empty DB + `onboarding_seen == "true"` → `.dashboard`
    func testEmptyDBOnboardingSeen_ShowsDashboard() async throws {
        let db = try await makeDB()
        let appStateRepo = AppStateRepository(database: db)
        try await appStateRepo.set(key: "onboarding_seen", value: "true")

        let state = makeState(db: db)
        await state.determineLaunchScreen()
        XCTAssertEqual(state.currentScreen, .dashboard)
    }

    /// DB with projects + no onboarding flag → `.dashboard` (populated)
    func testDBWithProjects_ShowsDashboard() async throws {
        let db = try await makeDB()
        let projectRepo = ProjectRepository(database: db)
        let project = Project(name: "test", rootPath: "/tmp/test")
        try await projectRepo.create(project)

        let state = makeState(db: db)
        await state.determineLaunchScreen()
        XCTAssertEqual(state.currentScreen, .dashboard)
    }

    /// `makeCriticalErrorState` sets the screen to `.criticalError`.
    func testCriticalErrorState() async throws {
        let (state, screen) = await AppState.makeCriticalErrorState(message: "DB open failed: test")
        XCTAssertEqual(screen, .criticalError("DB open failed: test"))
        XCTAssertEqual(state.currentScreen, .criticalError("DB open failed: test"))
    }
}
