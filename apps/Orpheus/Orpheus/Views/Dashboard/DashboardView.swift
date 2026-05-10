import SwiftUI
import OrpheusDesign
import OrpheusCore

/// W1 (empty dashboard) and W2 (populated dashboard) combined.
/// Switches between the two states based on `viewModel.projects.isEmpty`.
struct DashboardView: View {
    @Environment(AppState.self) private var appState

    private var vm: DashboardViewModel { appState.dashboardViewModel }

    var body: some View {
        Group {
            if vm.isLoading {
                LoadingSkeleton(rows: 4, hasHeader: true)
                    .padding(OrpheusSpacing.lg)
            } else if vm.projects.isEmpty {
                emptyDashboard
            } else {
                populatedDashboard
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .orpheusBackground(OrpheusColor.Surface.base)
    }

    // MARK: - W1: Empty dashboard

    private var emptyDashboard: some View {
        VStack(spacing: OrpheusSpacing.xl) {
            Spacer()

            VStack(spacing: OrpheusSpacing.md) {
                OrpheusText(
                    "Welcome to Orpheus",
                    style: OrpheusTypography.display,
                    color: OrpheusColor.Text.primary,
                    alignment: .center
                )

                OrpheusText(
                    "Create or open a project to start.",
                    style: OrpheusTypography.body,
                    color: OrpheusColor.Text.secondary,
                    alignment: .center
                )
            }

            HStack(spacing: OrpheusSpacing.sm) {
                OrpheusButton("+ New project", variant: .primary, size: .large) {
                    addRepository()
                }
                OrpheusButton("Open folder...", variant: .secondary, size: .large) {
                    addRepository()
                }
            }

            OrpheusText(
                "Cmd+N for a new space",
                style: OrpheusTypography.caption,
                color: OrpheusColor.Text.tertiary,
                alignment: .center
            )

            Spacer()
        }
        .padding(OrpheusSpacing.xl)
    }

    // MARK: - W2: Populated dashboard

    private var populatedDashboard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: OrpheusSpacing.lg) {
                // Header
                HStack {
                    OrpheusText("Dashboard",
                                style: OrpheusTypography.title,
                                color: OrpheusColor.Text.primary)
                    Spacer()
                    OrpheusButton("+ Project", variant: .primary, size: .small) {
                        addRepository()
                    }
                }

                // Activity heatmap (stub)
                ActivityHeatmapStub()

                // Split body
                HStack(alignment: .top, spacing: OrpheusSpacing.lg) {
                    ProjectsListPane()
                        .environment(appState)
                        .frame(maxWidth: .infinity)

                    SessionsListPane()
                        .environment(appState)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(OrpheusSpacing.lg)
        }
    }

    // MARK: - Actions

    private func addRepository() {
        Task { @MainActor in
            guard let url = await presentFolderPicker() else { return }
            do {
                let spaceID = try await appState.sidebarViewModel.addProject(
                    name: url.lastPathComponent,
                    rootPath: url.path
                )
                try? await appState.appStateRepository.set(
                    key: "onboarding_seen", value: "true"
                )
                appState.sidebarViewModel.select(.space(spaceID))
                appState.currentScreen = .emptySpace(spaceID)
            } catch {
                OrpheusAppLogger.errors.error(
                    "Dashboard add project failed: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
    }

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
}
