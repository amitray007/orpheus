import AppKit
import Foundation
import OrpheusCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {

    private var mainWindowController: MainWindowController?
    private var appState: AppState?

    // MARK: - Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide any empty placeholder windows that @main creates.
        for window in NSApp.windows {
            if window.frame.width < 10 {
                window.orderOut(nil)
            }
        }

        Task {
            await launch()
        }
    }

    private func launch() async {
        let dbPath = DBLocator.resolve()

        // Ensure the ~/.orpheus/ directory exists
        do {
            try DBLocator.ensureDirectoryExists(for: dbPath)
        } catch {
            OrpheusAppLogger.errors.error(
                "Cannot create DB directory: \(error.localizedDescription, privacy: .public)"
            )
        }

        // Open database
        let db: OrpheusCore.Database
        do {
            db = try await OrpheusCore.Database(path: dbPath)
        } catch {
            OrpheusAppLogger.errors.error(
                "DB open failed: \(error.localizedDescription, privacy: .public)"
            )
            let appError = OrpheusAppError.databaseOpenFailed(reason: error.localizedDescription)
            await showCriticalErrorWindow(message: appError.errorDescription ?? "Unknown DB error")
            return
        }

        // Build repositories
        let projectRepo = ProjectRepository(database: db)
        let spaceRepo = SpaceRepository(database: db)
        let terminalRepo = TerminalRepository(database: db)
        let appStateRepo = AppStateRepository(database: db)

        // Build session registry pointing at ~/.claude/projects/
        let claudeProjectsURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects", isDirectory: true)
        let sessionRegistry = SessionRegistry(rootURL: claudeProjectsURL)

        // Build AppState
        let state = AppState(
            database: db,
            projectRepository: projectRepo,
            spaceRepository: spaceRepo,
            terminalRepository: terminalRepo,
            appStateRepository: appStateRepo,
            sessionRegistry: sessionRegistry
        )
        // Second-phase: wire the OnboardingViewModel (needs self reference)
        state.wireOnboardingViewModel()
        self.appState = state

        // Determine launch screen (onboarding vs dashboard)
        await state.determineLaunchScreen()

        // Restore window geometry before showing window
        let savedGeometry = try? await appStateRepo.get(key: "window_geometry")

        // Create and show main window
        let windowController = MainWindowController(appState: state)
        self.mainWindowController = windowController

        if let geometryString = savedGeometry,
           let data = geometryString.data(using: .utf8),
           let rect = try? JSONDecoder().decode(CGRect.self, from: data) {
            windowController.window?.setFrame(rect, display: false)
        }

        windowController.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Start background services after window is visible
        await state.startServices()
    }

    private func showCriticalErrorWindow(message: String) async {
        let (state, _) = await AppState.makeCriticalErrorState(message: message)
        self.appState = state
        let windowController = MainWindowController(appState: state)
        self.mainWindowController = windowController
        windowController.showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Termination

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        OrpheusAppLogger.app.info("Application will terminate.")
    }
}

