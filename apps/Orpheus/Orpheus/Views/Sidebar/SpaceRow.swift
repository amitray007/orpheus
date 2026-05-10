import SwiftUI
import OrpheusDesign
import OrpheusCore

/// One space row inside an expanded project in the sidebar.
/// Activity indicator: `*` for running terminals, `o` for dormant, `.` for empty.
struct SpaceRow: View {
    let space: Space
    let project: Project
    @Environment(AppState.self) private var appState

    private var vm: SidebarViewModel { appState.sidebarViewModel }
    private var terminalCount: Int { vm.terminalCountBySpace[space.id] ?? 0 }
    private var isSelected: Bool { vm.selectedItem == .space(space.id) }

    var body: some View {
        OrpheusRow(
            space.name,
            subtitle: terminalCount == 0 ? "no active terminals" : nil,
            leading: activityIcon,
            isSelected: isSelected,
            onTap: {
                vm.select(.space(space.id))
                if terminalCount == 0 {
                    appState.currentScreen = .emptySpace(space.id)
                } else {
                    // Phase 2C: show terminal layout
                    appState.currentScreen = .terminalPlaceholder(space.id)
                }
            }
        )
    }

    private var activityIcon: OrpheusIcon {
        if terminalCount > 0 {
            return OrpheusIcon(systemName: "circle.fill", size: .small,
                               color: OrpheusColor.Semantic.success)
        } else {
            return OrpheusIcon(systemName: "circle", size: .small,
                               color: OrpheusColor.Text.disabled)
        }
    }
}
