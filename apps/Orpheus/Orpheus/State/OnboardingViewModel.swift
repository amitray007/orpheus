import AppKit
import Foundation
import Observation
import OrpheusCore

/// View model for the W18 onboarding flow.
///
/// Uses a two-phase init pattern because it needs a reference to `AppState`,
/// which is itself not fully initialized when `OnboardingViewModel` is created.
/// Call `__wire(...)` immediately after `AppState.init` completes.
@Observable
@MainActor
final class OnboardingViewModel {

    // MARK: - Observed state

    var isAdding: Bool = false

    // MARK: - Private — set by __wire

    private weak var appState: AppState?
    private var projectRepository: ProjectRepository?
    private var spaceRepository: SpaceRepository?
    private var appStateRepository: AppStateRepository?

    // MARK: - Two-phase init

    /// Phase 1: create a placeholder with no dependencies wired.
    static func __placeholder() -> OnboardingViewModel {
        OnboardingViewModel()
    }

    private init() {}

    /// Phase 2: wire the actual dependencies after `AppState` is fully initialized.
    func __wire(
        appState: AppState,
        projectRepository: ProjectRepository,
        spaceRepository: SpaceRepository,
        appStateRepository: AppStateRepository
    ) {
        self.appState = appState
        self.projectRepository = projectRepository
        self.spaceRepository = spaceRepository
        self.appStateRepository = appStateRepository
    }

    // MARK: - Public actions

    /// Present an NSOpenPanel folder picker. On selection, creates a Project
    /// + Default Space, sets the onboarding_seen flag, then navigates to
    /// the space's EmptySpaceView (W3).
    func addRepositoryViaFolderPicker() {
        guard let projectRepository, let spaceRepository, let appStateRepository else {
            OrpheusAppLogger.errors.error("OnboardingViewModel not wired — call __wire first")
            return
        }

        isAdding = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.isAdding = false }

            guard let url = await presentFolderPicker() else {
                OrpheusAppLogger.onboarding.info("User cancelled folder picker.")
                return
            }

            do {
                let defaultSpaceID = try await createProjectAndDefaultSpace(
                    at: url,
                    projectRepository: projectRepository,
                    spaceRepository: spaceRepository
                )
                try await markOnboardingSeen(appStateRepository: appStateRepository)
                self.appState?.currentScreen = .emptySpace(defaultSpaceID)
                OrpheusAppLogger.onboarding.info(
                    "Onboarding complete. Default space: \(defaultSpaceID.rawValue, privacy: .public)"
                )
            } catch {
                OrpheusAppLogger.errors.error(
                    "Onboarding project creation failed: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
    }

    /// Skip onboarding — navigate directly to dashboard.
    func skipOnboarding() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let appStateRepository {
                try? await appStateRepository.set(key: "onboarding_seen", value: "true")
            }
            self.appState?.currentScreen = .dashboard
        }
    }

    // MARK: - Testable helpers (internal for unit tests)

    /// Creates a `Project` and a `Default Space` for the given URL.
    /// Returns the `SpaceID` of the Default Space.
    func createProjectAndDefaultSpace(at url: URL) async throws -> SpaceID {
        guard let projectRepository, let spaceRepository else {
            throw OrpheusAppError.onboardingFailed(reason: "OnboardingViewModel not wired")
        }
        return try await createProjectAndDefaultSpace(
            at: url,
            projectRepository: projectRepository,
            spaceRepository: spaceRepository
        )
    }

    func markOnboardingSeen() async throws {
        guard let appStateRepository else {
            throw OrpheusAppError.onboardingFailed(reason: "OnboardingViewModel not wired")
        }
        try await appStateRepository.set(key: "onboarding_seen", value: "true")
    }

    // MARK: - Private helpers

    private func presentFolderPicker() async -> URL? {
        await withCheckedContinuation { continuation in
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.message = "Select a project folder to add to Orpheus"
            panel.prompt = "Add Repository"
            let response = panel.runModal()
            continuation.resume(returning: response == .OK ? panel.url : nil)
        }
    }

    private func createProjectAndDefaultSpace(
        at url: URL,
        projectRepository: ProjectRepository,
        spaceRepository: SpaceRepository
    ) async throws -> SpaceID {
        let name = url.lastPathComponent
        let project = Project(name: name, rootPath: url.path)
        try await projectRepository.create(project)
        let space = Space(
            projectID: project.id,
            name: "Default Space",
            layoutSpec: .canvas([]),
            ord: 0
        )
        try await spaceRepository.create(space)
        return space.id
    }

    private func markOnboardingSeen(appStateRepository: AppStateRepository) async throws {
        try await appStateRepository.set(key: "onboarding_seen", value: "true")
    }
}
