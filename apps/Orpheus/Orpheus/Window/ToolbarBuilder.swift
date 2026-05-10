import AppKit
import SwiftUI
import OrpheusDesign

/// Identifiers for `NSToolbar` items.
enum ToolbarItemID {
    static let sidebarToggle  = NSToolbarItem.Identifier("com.orpheus.toolbar.sidebarToggle")
    static let search         = NSToolbarItem.Identifier("com.orpheus.toolbar.search")
    static let flexibleSpace  = NSToolbarItem.Identifier.flexibleSpace
    static let userMenu       = NSToolbarItem.Identifier("com.orpheus.toolbar.userMenu")
}

/// Builds and configures the custom `NSToolbar` for the main window.
/// AppKit owns the toolbar; SwiftUI views are hosted via `NSHostingView`
/// inside each custom-view `NSToolbarItem`.
@MainActor
final class ToolbarBuilder: NSObject, NSToolbarDelegate {

    private weak var appState: AppState?
    private weak var sidebarVM: SidebarViewModel?

    init(appState: AppState, sidebarVM: SidebarViewModel) {
        self.appState = appState
        self.sidebarVM = sidebarVM
    }

    func makeToolbar() -> NSToolbar {
        let toolbar = NSToolbar(identifier: "com.orpheus.main-toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.showsBaselineSeparator = false
        toolbar.allowsUserCustomization = false
        return toolbar
    }

    // MARK: - NSToolbarDelegate

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [
            ToolbarItemID.sidebarToggle,
            ToolbarItemID.flexibleSpace,
            ToolbarItemID.search,
            ToolbarItemID.flexibleSpace,
            ToolbarItemID.userMenu,
        ]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        switch itemIdentifier {
        case ToolbarItemID.sidebarToggle:
            return makeSidebarToggleItem()
        case ToolbarItemID.search:
            return makeSearchItem()
        case ToolbarItemID.userMenu:
            return makeUserMenuItem()
        default:
            return nil
        }
    }

    // MARK: - Item factories

    private func makeSidebarToggleItem() -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: ToolbarItemID.sidebarToggle)
        item.label = "Toggle Sidebar"
        item.toolTip = "Toggle Sidebar"

        let button = OrpheusButton(
            "",
            leadingIcon: OrpheusIcon(systemName: "sidebar.left", size: .medium,
                                     color: OrpheusColor.Text.secondary),
            variant: .ghost,
            size: .medium
        ) { // orpheus-allow:stock-control
            // Sidebar toggle — Phase 2C will wire sidebar collapse
        }
        let host = NSHostingView(rootView: button.orpheusTheme(nil))
        host.setFrameSize(NSSize(width: 32, height: 32))
        item.view = host
        item.minSize = NSSize(width: 32, height: 32)
        item.maxSize = NSSize(width: 32, height: 32)
        return item
    }

    private func makeSearchItem() -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: ToolbarItemID.search)
        item.label = "Search"

        let searchView = HStack(spacing: OrpheusSpacing.xs) {
            OrpheusIconSlot.search(size: .small, color: OrpheusColor.Text.tertiary)
            OrpheusText("Search", style: OrpheusTypography.body, color: OrpheusColor.Text.disabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, OrpheusSpacing.sm)
        .frame(height: 28)
        .background(
            RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous)
                .fill(OrpheusColor.Surface.elevated.resolved)
        )
        .overlay(
            RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous)
                .strokeBorder(OrpheusColor.Border.subtle.resolved, lineWidth: 1)
        )
        .frame(minWidth: 200, maxWidth: 400)

        let host = NSHostingView(rootView: searchView.orpheusTheme(nil))
        host.setFrameSize(NSSize(width: 240, height: 28))
        item.view = host
        item.minSize = NSSize(width: 160, height: 28)
        item.maxSize = NSSize(width: 400, height: 28)
        return item
    }

    private func makeUserMenuItem() -> NSToolbarItem {
        let item = NSToolbarItem(itemIdentifier: ToolbarItemID.userMenu)
        item.label = "User"

        let userView = OrpheusButton(
            "User",
            trailingIcon: OrpheusIcon(systemName: "chevron.down", size: .small,
                                      color: OrpheusColor.Text.secondary),
            variant: .ghost,
            size: .small
        ) { // orpheus-allow:stock-control
            // User menu — Phase 4
        }
        let host = NSHostingView(rootView: userView.orpheusTheme(nil))
        host.setFrameSize(NSSize(width: 72, height: 28))
        item.view = host
        item.minSize = NSSize(width: 72, height: 28)
        item.maxSize = NSSize(width: 120, height: 28)
        return item
    }
}
