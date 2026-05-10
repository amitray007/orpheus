import SwiftUI
import OrpheusDesign
import OrpheusCore

/// One project row in the sidebar tree. Shows the logo glyph, name, space count,
/// and a chevron for expand/collapse. Expanded state reveals `SpaceRow` entries.
struct ProjectRow: View {
    let project: Project
    @Environment(AppState.self) private var appState

    private var vm: SidebarViewModel { appState.sidebarViewModel }
    private var isExpanded: Bool { vm.expandedProjects.contains(project.id) }
    private var spaceCount: Int { vm.spaceCount(for: project.id) }
    private var spaces: [Space] { vm.spacesByProject[project.id] ?? [] }
    private var isSelected: Bool { vm.selectedItem == .project(project.id) }

    var body: some View {
        VStack(spacing: 0) {
            // Project row
            OrpheusRow(
                project.name,
                leading: logoIcon,
                trailingBadge: AnyView(countBadge),
                trailing: AnyView(chevron),
                isSelected: isSelected,
                onTap: {
                    vm.select(.project(project.id))
                    vm.toggleExpand(project.id)
                    appState.currentScreen = .dashboard
                }
            )

            // Nested space rows (visible when expanded)
            if isExpanded {
                ForEach(spaces, id: \.id) { space in
                    SpaceRow(space: space, project: project)
                        .environment(appState)
                        .padding(.leading, OrpheusSpacing.md)
                }

                // "+ New space" stub
                OrpheusRow(
                    "New space",
                    leading: OrpheusIcon(systemName: "plus", size: .small,
                                         color: OrpheusColor.Text.disabled),
                    isSelected: false,
                    onTap: {
                        // Phase 2C: new-space modal (W11)
                    }
                )
                .padding(.leading, OrpheusSpacing.md)
                .opacity(0.6)
            }
        }
    }

    private var logoIcon: OrpheusIcon {
        if vm.isGitProject(project) {
            return OrpheusIcon(systemName: "g.circle.fill", size: .medium,
                               color: OrpheusColor.Accent.primary)
        } else {
            return OrpheusIcon(systemName: "tilde.circle.fill", size: .medium,
                               color: OrpheusColor.Text.secondary)
        }
    }

    private var countBadge: some View {
        OrpheusText(
            "(\(spaceCount))",
            style: OrpheusTypography.caption,
            color: OrpheusColor.Text.tertiary
        )
    }

    private var chevron: some View {
        Group {
            if isExpanded {
                OrpheusIconSlot.chevronOpen()
            } else {
                OrpheusIconSlot.chevronClosed()
            }
        }
    }
}
