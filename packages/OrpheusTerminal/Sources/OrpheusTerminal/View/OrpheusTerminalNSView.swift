import AppKit
import GhosttyTerminal

/// An NSView that embeds an `OrpheusTerminalSurface` (and its underlying
/// `AppTerminalView`) in a host view hierarchy.
///
/// The view is a simple container: it constrains the `AppTerminalView` to fill
/// its bounds and forwards first-responder status. Keyboard, mouse, and IME
/// input are handled entirely by `AppTerminalView` — we don't re-implement any
/// of those paths.
public final class OrpheusTerminalNSView: NSView {

    private let surface: OrpheusTerminalSurface
    private let terminalView: AppTerminalView

    public init(surface: OrpheusTerminalSurface) {
        self.surface = surface
        self.terminalView = surface.view
        super.init(frame: .zero)
        setupSubview()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setupSubview() {
        addSubview(terminalView)
        terminalView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            terminalView.topAnchor.constraint(equalTo: topAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        OrpheusTerminalLogger.view.debug("OrpheusTerminalNSView subview configured")
    }

    public override var acceptsFirstResponder: Bool { true }

    public override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        // Delegate focus to the inner AppTerminalView.
        window?.makeFirstResponder(terminalView)
        return result
    }
}
