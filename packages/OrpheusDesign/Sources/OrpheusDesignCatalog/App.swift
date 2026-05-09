import AppKit
import SwiftUI
import OrpheusDesign

// MARK: - App entry

enum CatalogApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = CatalogAppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}

// MARK: - App delegate

private final class CatalogAppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "OrpheusDesignCatalog \(OrpheusDesign.version)"
        window.minSize = NSSize(width: 1440, height: 900)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden

        let rootView = CatalogRoot()
        let hosting = NSHostingView(rootView: rootView)
        hosting.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = hosting

        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

// MARK: - Layout mode

enum CatalogLayout: String, CaseIterable, Identifiable {
    case sideBySide = "Side by Side"
    case darkOnly   = "Dark Only"
    case lightOnly  = "Light Only"
    var id: String { rawValue }
}

// MARK: - CatalogRoot

struct CatalogRoot: View {
    @State private var layout: CatalogLayout = .sideBySide

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
                .overlay(OrpheusColor.Border.subtle.resolved)
            content
        }
        .orpheusTheme(.dark)
        .frame(minWidth: 1440, minHeight: 900)
    }

    // MARK: Toolbar

    private var toolbar: some View {
        HStack(spacing: OrpheusSpacing.md) {
            OrpheusText(
                "OrpheusDesign \(OrpheusDesign.version)",
                style: OrpheusTypography.heading,
                color: OrpheusColor.Text.primary
            )

            Spacer(minLength: 0)

            // Layout picker — custom segmented control using OrpheusButton
            HStack(spacing: OrpheusSpacing.xxs) {
                ForEach(CatalogLayout.allCases) { mode in
                    OrpheusButton(
                        mode.rawValue,
                        variant: layout == mode ? .primary : .secondary,
                        size: .small,
                        action: { layout = mode }
                    )
                }
            }
        }
        .padding(.horizontal, OrpheusSpacing.md)
        .frame(height: 44)
        .orpheusMaterial(OrpheusMaterial.toolbar)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch layout {
        case .sideBySide:
            HStack(spacing: 0) {
                ScrollView(.vertical, showsIndicators: true) {
                    CatalogBody()
                        .padding(OrpheusSpacing.lg)
                }
                .orpheusTheme(.dark)
                .frame(maxWidth: .infinity)
                .orpheusBackground(OrpheusColor.Surface.base)

                Rectangle()
                    .fill(OrpheusColor.Border.subtle.resolved)
                    .frame(width: 1)

                ScrollView(.vertical, showsIndicators: true) {
                    CatalogBody()
                        .padding(OrpheusSpacing.lg)
                }
                .orpheusTheme(.light)
                .frame(maxWidth: .infinity)
                .orpheusBackground(OrpheusColor.Surface.base)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .darkOnly:
            ScrollView(.vertical, showsIndicators: true) {
                CatalogBody()
                    .padding(OrpheusSpacing.lg)
            }
            .orpheusTheme(.dark)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .orpheusBackground(OrpheusColor.Surface.base)

        case .lightOnly:
            ScrollView(.vertical, showsIndicators: true) {
                CatalogBody()
                    .padding(OrpheusSpacing.lg)
            }
            .orpheusTheme(.light)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .orpheusBackground(OrpheusColor.Surface.base)
        }
    }
}
