import AppKit
import Foundation
import OrpheusTerminal

// MARK: - Boot diagnostics

print("[OrpheusTerminalSmoke] Phase 2A smoke harness starting")
print("[OrpheusTerminalSmoke] libghostty-spm tag: 1.0.1777879537")

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var surface: OrpheusTerminalSurface?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let engine = OrpheusTerminalEngine.shared
        let config = SurfaceConfig(
            command: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh",
            arguments: ["-i", "-l"],
            cwd: FileManager.default.homeDirectoryForCurrentUser,
            palette: .orpheusDefault
        )

        let terminalSurface: OrpheusTerminalSurface
        do {
            terminalSurface = try engine.makeSurface(config: config)
        } catch {
            print("[OrpheusTerminalSmoke] FATAL: surface creation failed: \(error)")
            NSApp.terminate(nil)
            return
        }

        self.surface = terminalSurface
        print("[OrpheusTerminalSmoke] Surface created, opening window")

        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 440),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = "Orpheus Terminal \u{2014} Phase 2A Smoke"
        win.delegate = self

        let hostView = OrpheusTerminalNSView(surface: terminalSurface)
        win.contentView = hostView

        win.center()
        win.makeKeyAndOrderFront(nil)
        win.makeFirstResponder(terminalSurface.view)

        self.window = win
        print("[OrpheusTerminalSmoke] Window opened (720x440). Type 'exit' or press ⌘W to close.")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

extension AppDelegate: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) {
        surface?.close()
        surface = nil
        print("[OrpheusTerminalSmoke] Window closed — surface released")
    }
}

// MARK: - Run loop

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.activate(ignoringOtherApps: true)
app.run()
