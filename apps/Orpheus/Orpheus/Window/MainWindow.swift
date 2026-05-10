import AppKit

/// Custom `NSWindow` with transparent title bar and hidden title text.
/// Traffic lights remain in their standard position — repositioning them
/// is a private-API trap that breaks under Stage Manager and accessibility.
final class MainWindow: NSWindow {

    override init(
        contentRect: NSRect,
        styleMask: NSWindow.StyleMask,
        backing: NSWindow.BackingStoreType,
        defer flag: Bool
    ) {
        let style: NSWindow.StyleMask = [
            .titled,
            .closable,
            .miniaturizable,
            .resizable,
            .fullSizeContentView,
        ]
        super.init(
            contentRect: contentRect,
            styleMask: style,
            backing: backing,
            defer: flag
        )
        configure()
    }

    private func configure() {
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        isMovableByWindowBackground = true
        minSize = NSSize(width: 880, height: 520)
        setFrameAutosaveName("OrpheusMainWindow")
        isReleasedWhenClosed = false
        backgroundColor = .clear
    }
}
