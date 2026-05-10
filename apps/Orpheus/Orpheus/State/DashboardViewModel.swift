import Foundation
import Observation
import OrpheusCore

/// View model for W1 (empty dashboard) and W2 (populated dashboard).
@Observable
@MainActor
final class DashboardViewModel {

    // MARK: - Observed state

    var projects: [Project] = []
    var recentSessions: [SessionMetadata] = []
    var isLoading: Bool = true

    // MARK: - Private

    private let projectRepository: ProjectRepository
    private let sessionRegistry: SessionRegistry

    private var projectsTask: Task<Void, Never>?
    private var sessionsTask: Task<Void, Never>?
    private var refreshTimer: Task<Void, Never>?

    // MARK: - Init

    init(
        projectRepository: ProjectRepository,
        sessionRegistry: SessionRegistry
    ) {
        self.projectRepository = projectRepository
        self.sessionRegistry = sessionRegistry
    }

    // MARK: - Start

    func start() {
        startProjectObservation()
        startSessionsRefresh()
    }

    func cleanup() {
        projectsTask?.cancel()
        projectsTask = nil
        sessionsTask?.cancel()
        sessionsTask = nil
        refreshTimer?.cancel()
        refreshTimer = nil
    }

    // MARK: - Private

    private func startProjectObservation() {
        projectsTask?.cancel()
        projectsTask = Task { [weak self] in
            guard let self else { return }
            var receivedFirst = false
            for await snapshot in await projectRepository.observeAll() {
                guard !Task.isCancelled else { return }
                self.projects = snapshot
                if !receivedFirst {
                    receivedFirst = true
                    self.isLoading = false
                }
            }
        }
    }

    private func startSessionsRefresh() {
        sessionsTask?.cancel()
        sessionsTask = Task { [weak self] in
            guard let self else { return }

            // Subscribe to session registry updates
            let updates = await self.sessionRegistry.updates()
            for await _ in updates {
                guard !Task.isCancelled else { return }
                await self.refreshRecentSessions()
            }
        }

        // Also refresh every 30 seconds as a fallback
        refreshTimer?.cancel()
        refreshTimer = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard !Task.isCancelled else { return }
                await self.refreshRecentSessions()
            }
        }

        // Initial load
        Task { [weak self] in
            await self?.refreshRecentSessions()
        }
    }

    private func refreshRecentSessions() async {
        recentSessions = await sessionRegistry.recent(limit: 6)
    }
}
