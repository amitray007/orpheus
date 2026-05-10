import AppKit
import SwiftUI
import OrpheusDesign

/// Owns the `MainWindow` and hosts the SwiftUI `ContentView` via `NSHostingView`.
/// Wires the AppKit window geometry persistence on the `NSWindowDelegate` path.
@MainActor
final class MainWindowController: NSWindowController, NSWindowDelegate {

    private let appState: AppState
    private var toolbarBuilder: ToolbarBuilder?

    init(appState: AppState) {
        self.appState = appState

        let window = MainWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 680),
            styleMask: [],   // MainWindow sets its own style mask
            backing: .buffered,
            defer: false
        )

        super.init(window: window)

        window.delegate = self
        setupToolbar(window: window)
        setupContent(window: window)

        window.center()
    }

    required init?(coder: NSCoder) {
        fatalError("Not used — MainWindowController is always created programmatically")
    }

    // MARK: - Setup

    private func setupToolbar(window: NSWindow) {
        let builder = ToolbarBuilder(
            appState: appState,
            sidebarVM: appState.sidebarViewModel
        )
        window.toolbar = builder.makeToolbar()
        self.toolbarBuilder = builder
    }

    private func setupContent(window: NSWindow) {
        let contentView = ContentView()
            .environment(appState)
            .orpheusTheme(nil)   // follow system color scheme

        let hostingView = NSHostingView(rootView: contentView)
        hostingView.autoresizingMask = [.width, .height]
        window.contentView = hostingView
    }

    // MARK: - NSWindowDelegate — geometry persistence

    func windowDidEndLiveResize(_ notification: Notification) {
        persistGeometry()
    }

    func windowDidMove(_ notification: Notification) {
        persistGeometry()
    }

    private func persistGeometry() {
        guard let window else { return }
        let rect = window.frame
        Task { @MainActor in
            if let data = try? JSONEncoder().encode(rect),
               let str = String(data: data, encoding: .utf8) {
                try? await self.appState.appStateRepository.set(
                    key: "window_geometry",
                    value: str
                )
            }
        }
    }
}
