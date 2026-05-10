import Foundation
import Observation
import OrpheusCore

/// The active screen in the main content area.
enum Screen: Equatable {
    case onboarding
    case dashboard
    case emptySpace(SpaceID)
    case terminalPlaceholder(SpaceID)   // Phase 2C will swap this for real terminals
    case sessions                        // stubbed — Phase 4
    case criticalError(String)
}

/// Root observable state container. `@MainActor`-isolated so all property
/// mutations land on the main thread. SwiftUI views observe via `@State` /
/// `@Bindable` with no extra bridging needed.
///
/// Note: `@Observable` doesn't support `lazy` stored properties.
/// Sub-view-models are created eagerly in `init` since they are lightweight
/// (no async work on init per discipline.md).
@Observable
@MainActor
final class AppState {

    // MARK: - Core dependencies

    let database: OrpheusCore.Database
    let projectRepository: ProjectRepository
    let spaceRepository: SpaceRepository
    let terminalRepository: TerminalRepository
    let appStateRepository: AppStateRepository
    let sessionRegistry: SessionRegistry

    // MARK: - Sub-view-models

    let sidebarViewModel: SidebarViewModel
    let dashboardViewModel: DashboardViewModel
    let onboardingViewModel: OnboardingViewModel

    // MARK: - Navigation state

    var currentScreen: Screen = .dashboard

    // MARK: - Init (normal launch)

    init(
        database: OrpheusCore.Database,
        projectRepository: ProjectRepository,
        spaceRepository: SpaceRepository,
        terminalRepository: TerminalRepository,
        appStateRepository: AppStateRepository,
        sessionRegistry: SessionRegistry
    ) {
        self.database = database
        self.projectRepository = projectRepository
        self.spaceRepository = spaceRepository
        self.terminalRepository = terminalRepository
        self.appStateRepository = appStateRepository
        self.sessionRegistry = sessionRegistry

        // Eagerly create sub-view-models (fast, no async — discipline rule)
        self.sidebarViewModel = SidebarViewModel(
            projectRepository: projectRepository,
            spaceRepository: spaceRepository,
            terminalRepository: terminalRepository
        )
        self.dashboardViewModel = DashboardViewModel(
            projectRepository: projectRepository,
            sessionRegistry: sessionRegistry
        )
        // OnboardingViewModel gets set after self is fully initialized (two-phase)
        self.onboardingViewModel = OnboardingViewModel.__placeholder()
    }

    /// Second-phase setup: wire the OnboardingViewModel which needs a reference to self.
    func wireOnboardingViewModel() {
        onboardingViewModel.__wire(
            appState: self,
            projectRepository: projectRepository,
            spaceRepository: spaceRepository,
            appStateRepository: appStateRepository
        )
    }

    // MARK: - Launch decision tree

    /// Determine the initial screen per the onboarding rules:
    /// - If `onboarding_seen != "true"` AND projects table is empty → .onboarding
    /// - Otherwise → .dashboard
    func determineLaunchScreen() async {
        do {
            let onboardingSeen = try await appStateRepository.get(key: "onboarding_seen")
            let projects = try await projectRepository.fetchAll()
            if onboardingSeen != "true" && projects.isEmpty {
                currentScreen = .onboarding
            } else {
                currentScreen = .dashboard
            }
        } catch {
            OrpheusAppLogger.errors.error(
                "Launch screen decision failed: \(error.localizedDescription, privacy: .public)"
            )
            currentScreen = .dashboard
        }
    }

    // MARK: - Background services

    func startServices() async {
        // Start the session registry scan
        let stream = await sessionRegistry.updates()
        try? await sessionRegistry.start()

        // Consume updates — fire-and-forget to keep registry alive
        Task {
            for await _ in stream { }
        }

        // Start sidebar and dashboard observation
        sidebarViewModel.start()
        dashboardViewModel.start()
    }
}

// MARK: - Critical error factory

extension AppState {
    /// Creates a minimal AppState for the critical-error path.
    /// The DB is in-memory since the real DB failed to open.
    static func makeCriticalErrorState(message: String) async -> (AppState, Screen) {
        guard let db = try? await OrpheusCore.Database(inMemory: ()) else {
            fatalError("Cannot create in-memory DB for critical error state")
        }
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
        state.currentScreen = .criticalError(message)
        return (state, .criticalError(message))
    }
}
