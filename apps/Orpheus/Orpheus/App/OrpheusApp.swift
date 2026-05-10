import SwiftUI

/// App entry point. SwiftUI's `@main` satisfies the protocol with an empty
/// `WindowGroup` so the framework lifecycle machinery starts up; the actual
/// window is owned and shown by `AppDelegate` / `MainWindowController`.
@main
struct OrpheusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Empty scene — the real window is managed by MainWindowController
        // in AppDelegate. We only need this to satisfy the App protocol.
        WindowGroup {
            EmptyView()
                .frame(width: 0, height: 0)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 0, height: 0)
    }
}
