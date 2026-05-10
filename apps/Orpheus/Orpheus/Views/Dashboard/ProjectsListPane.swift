import SwiftUI
import OrpheusDesign
import OrpheusCore

/// W2 left split: list of all projects with logo + name + space count.
struct ProjectsListPane: View {
    @Environment(AppState.self) private var appState

    private var vm: DashboardViewModel { appState.dashboardViewModel }
    private var sidebarVM: SidebarViewModel { appState.sidebarViewModel }

    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
            OrpheusText("Projects",
                        style: OrpheusTypography.heading,
                        color: OrpheusColor.Text.primary)

            if vm.projects.isEmpty {
                EmptyState(
                    title: "No projects",
                    message: "Add a repository to get started.",
                    ctaLabel: nil,
                    ctaAction: nil
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(vm.projects, id: \.id) { project in
                            projectRow(project)
                            Divider()
                                .overlay(OrpheusColor.Border.subtle.resolved)
                        }
                    }
                }
            }
        }
    }

    private func projectRow(_ project: Project) -> some View {
        let spaceCount = sidebarVM.spaceCount(for: project.id)
        let isGit = sidebarVM.isGitProject(project)

        return OrpheusRow(
            project.name,
            leading: OrpheusIcon(
                systemName: isGit ? "g.circle.fill" : "tilde.circle.fill",
                size: .medium,
                color: isGit ? OrpheusColor.Accent.primary : OrpheusColor.Text.secondary
            ),
            trailingBadge: AnyView(
                OrpheusText("(\(spaceCount))",
                            style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
            ),
            isSelected: false,
            onTap: {
                sidebarVM.select(.project(project.id))
                sidebarVM.expand(project.id)
                appState.currentScreen = .dashboard
            }
        )
    }
}
