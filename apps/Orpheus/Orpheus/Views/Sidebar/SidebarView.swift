import SwiftUI
import OrpheusDesign
import OrpheusCore

/// W1/W2 sidebar: top nav, pinned + projects sections, footer add button.
/// Uses `OrpheusSidebar` as the outer shell and composes `OrpheusRow` rows.
struct SidebarView: View {
    @Environment(AppState.self) private var appState

    private var vm: SidebarViewModel {
        appState.sidebarViewModel
    }

    var body: some View {
        OrpheusSidebar(
            width: 220,
            top: {
                topNav
            },
            bodyContent: {
                projectTree
            },
            bottom: {
                footer
            }
        )
    }

    // MARK: - Top nav

    private var topNav: some View {
        VStack(spacing: 0) {
            navRow(
                icon: "square.grid.2x2",
                label: "Dashboard",
                shortcut: nil,
                isSelected: vm.selectedItem == .dashboard
            ) {
                vm.select(.dashboard)
                appState.currentScreen = .dashboard
            }

            navRow(
                icon: "list.bullet.rectangle",
                label: "Sessions",
                shortcut: nil,
                isSelected: vm.selectedItem == .sessions
            ) {
                vm.select(.sessions)
                appState.currentScreen = .sessions
            }

            navRow(
                icon: "plus",
                label: "New Space",
                shortcut: "⌘N",
                isSelected: false
            ) {
                // Phase 2C: new-space modal (W11)
            }
        }
    }

    private func navRow(
        icon: String,
        label: String,
        shortcut: String?,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        OrpheusRow(
            label,
            leading: OrpheusIcon(systemName: icon, size: .small,
                                  color: isSelected
                                      ? OrpheusColor.Accent.primary
                                      : OrpheusColor.Text.secondary),
            trailing: shortcut.map { hint in
                AnyView(
                    OrpheusText(hint,
                                style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.disabled)
                )
            },
            isSelected: isSelected,
            onTap: action
        )
    }

    // MARK: - Project tree

    private var projectTree: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Pinned section
            if !vm.pinnedProjects.isEmpty {
                sectionHeader("Pinned")
                ForEach(vm.pinnedProjects, id: \.id) { project in
                    ProjectRow(project: project)
                        .environment(appState)
                }
            }

            // Projects section
            sectionHeader("Projects")
            if vm.unpinnedProjects.isEmpty && vm.pinnedProjects.isEmpty {
                OrpheusRow(
                    "(none yet)",
                    isSelected: false
                )
                .disabled(true)
                .opacity(0.5)
            } else {
                ForEach(vm.unpinnedProjects, id: \.id) { project in
                    ProjectRow(project: project)
                        .environment(appState)
                }
            }
        }
        .padding(.vertical, OrpheusSpacing.xxs)
    }

    private func sectionHeader(_ title: String) -> some View {
        OrpheusText(
            "-- \(title) --",
            style: OrpheusTypography.caption,
            color: OrpheusColor.Text.disabled
        )
        .padding(.horizontal, OrpheusSpacing.sm)
        .padding(.top, OrpheusSpacing.xs)
        .padding(.bottom, OrpheusSpacing.xxs)
    }

    // MARK: - Footer

    private var footer: some View {
        OrpheusButton(
            "Add repository",
            leadingIcon: OrpheusIcon(systemName: "plus", size: .small,
                                      color: OrpheusColor.Accent.primary),
            variant: .ghost,
            size: .small
        ) {
            addRepositoryFromSidebar()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func addRepositoryFromSidebar() {
        Task { @MainActor in
            guard let url = await presentFolderPicker() else { return }
            do {
                let spaceID = try await vm.addProject(
                    name: url.lastPathComponent,
                    rootPath: url.path
                )
                // Mark onboarding seen if it hasn't been
                try? await appState.appStateRepository.set(
                    key: "onboarding_seen", value: "true"
                )
                vm.select(.space(spaceID))
                appState.currentScreen = .emptySpace(spaceID)
            } catch {
                OrpheusAppLogger.errors.error(
                    "Sidebar add project failed: \(error.localizedDescription, privacy: .public)"
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

