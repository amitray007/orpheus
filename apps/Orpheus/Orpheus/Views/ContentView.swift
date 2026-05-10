import SwiftUI
import OrpheusDesign
import OrpheusCore

/// Root SwiftUI view. Hosts the sidebar + main content area in a horizontal
/// split. The `AppState` environment object drives which surface renders in
/// the main area.
struct ContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        HStack(spacing: 0) {
            // Sidebar — always visible
            SidebarView()
                .frame(width: 220)
                .environment(appState)

            // Divider
            Divider()
                .overlay(OrpheusColor.Border.subtle.resolved)

            // Main content area — driven by currentScreen
            mainContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .orpheusBackground(OrpheusColor.Surface.base)
        .ignoresSafeArea(.all)
    }

    @ViewBuilder
    private var mainContent: some View {
        switch appState.currentScreen {
        case .onboarding:
            OnboardingView()
                .environment(appState)

        case .dashboard:
            DashboardView()
                .environment(appState)

        case .emptySpace(let spaceID):
            EmptySpaceView(spaceID: spaceID)
                .environment(appState)
                .id(spaceID)

        case .terminalPlaceholder(let spaceID):
            TerminalPlaceholderView(spaceID: spaceID)

        case .sessions:
            SessionsPlaceholderView()

        case .criticalError(let message):
            CriticalErrorView(message: message)
        }
    }
}

// MARK: - Placeholder views for Phase 2C / 4

/// Placeholder for when a space has active terminals. Phase 2C replaces this.
private struct TerminalPlaceholderView: View {
    let spaceID: SpaceID

    var body: some View {
        VStack(spacing: OrpheusSpacing.md) {
            OrpheusIcon(systemName: "terminal", size: .xlarge,
                        color: OrpheusColor.Text.disabled)
            OrpheusText("Terminal View",
                        style: OrpheusTypography.title,
                        color: OrpheusColor.Text.secondary)
            OrpheusText("Phase 2C will host terminals here.",
                        style: OrpheusTypography.body,
                        color: OrpheusColor.Text.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .orpheusBackground(OrpheusColor.Surface.base)
    }
}

/// Placeholder for the sessions browser. Phase 4.
private struct SessionsPlaceholderView: View {
    var body: some View {
        VStack(spacing: OrpheusSpacing.md) {
            OrpheusIcon(systemName: "list.bullet.rectangle", size: .xlarge,
                        color: OrpheusColor.Text.disabled)
            OrpheusText("Sessions Browser",
                        style: OrpheusTypography.title,
                        color: OrpheusColor.Text.secondary)
            OrpheusText("Coming in Phase 4.",
                        style: OrpheusTypography.body,
                        color: OrpheusColor.Text.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .orpheusBackground(OrpheusColor.Surface.base)
    }
}
