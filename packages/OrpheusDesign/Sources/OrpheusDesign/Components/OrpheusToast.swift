import SwiftUI

// MARK: - Data model

/// Value type driving a single toast. Identifiable so `OrpheusToastStack`
/// can diff insertions/removals with `ForEach`.
public struct OrpheusToastItem: Identifiable, Sendable {
    public let id: UUID
    public let message: String
    public let kind: OrpheusToast.Kind
    public let title: String?
    public let icon: OrpheusIcon?
    public let onDismiss: (@Sendable () -> Void)?

    public init(
        id: UUID = UUID(),
        _ message: String,
        kind: OrpheusToast.Kind = .info,
        title: String? = nil,
        icon: OrpheusIcon? = nil,
        onDismiss: (@Sendable () -> Void)? = nil
    ) {
        self.id        = id
        self.message   = message
        self.kind      = kind
        self.title     = title
        self.icon      = icon
        self.onDismiss = onDismiss
    }
}

// MARK: - OrpheusToast

/// Transient notification matching the W19 error-toast pattern.
///
/// Lifecycle (auto-dismiss, timers) is a Phase 1+ concern. In v0 this view
/// is purely visual — the caller drives visibility and calls `onDismiss`.
public struct OrpheusToast: View {

    public enum Kind: Sendable, Equatable {
        case info, success, warning, critical
    }

    private let message: String
    private let kind: Kind
    private let title: String?
    private let icon: OrpheusIcon?
    private let onDismiss: (() -> Void)?

    @Environment(\.orpheusTheme) private var theme

    public init(
        _ message: String,
        kind: Kind = .info,
        title: String? = nil,
        icon: OrpheusIcon? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.message   = message
        self.kind      = kind
        self.title     = title
        self.icon      = icon
        self.onDismiss = onDismiss
    }

    public var body: some View {
        HStack(alignment: .top, spacing: OrpheusSpacing.sm) {
            // Leading icon
            leadingIcon
                .padding(.top, OrpheusSpacing.xxs)

            // Content column
            VStack(alignment: .leading, spacing: OrpheusSpacing.xxs) {
                if let title {
                    Text(title)
                        .orpheusFont(OrpheusTypography.heading)
                        .orpheusForeground(OrpheusColor.Text.primary)
                }
                Text(message)
                    .orpheusFont(OrpheusTypography.body)
                    .orpheusForeground(OrpheusColor.Text.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            // Dismiss button
            if let onDismiss {
                dismissButton(action: onDismiss)
            }
        }
        .padding(OrpheusSpacing.sm)
        .frame(maxWidth: 380, alignment: .leading)
        .orpheusMaterial(OrpheusMaterial.overlay)
        .orpheusBorder(OrpheusColor.Border.default, width: 1, cornerRadius: OrpheusRadius.card)
        .orpheusCornerRadius(OrpheusRadius.card)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    // MARK: - Sub-views

    private var leadingIcon: some View {
        let resolved = icon ?? defaultIcon
        return resolved
    }

    private var defaultIcon: OrpheusIcon {
        switch kind {
        case .info:     return OrpheusIconSlot.info()
        case .success:  return OrpheusIconSlot.success()
        case .warning:  return OrpheusIconSlot.warning()
        case .critical: return OrpheusIconSlot.critical()
        }
    }

    private func dismissButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            OrpheusIconSlot.close(size: .small, color: OrpheusColor.Text.tertiary)
                .padding(OrpheusSpacing.xxs)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
        .accessibilityAddTraits(.isButton)
    }

    private var accessibilityLabel: String {
        var parts: [String] = []
        parts.append(kindLabel)
        if let title { parts.append(title) }
        parts.append(message)
        return parts.joined(separator: ". ")
    }

    private var kindLabel: String {
        switch kind {
        case .info:     return "Info"
        case .success:  return "Success"
        case .warning:  return "Warning"
        case .critical: return "Error"
        }
    }
}

// MARK: - OrpheusToastStack

/// Vertically stacked toast container. Accepts an `[OrpheusToastItem]` and
/// renders each with appear/disappear transitions driven by
/// `OrpheusMotion.standardAnim`. Intended to be anchored top-trailing in
/// the window frame.
public struct OrpheusToastStack: View {

    private let items: [OrpheusToastItem]

    public init(_ items: [OrpheusToastItem]) {
        self.items = items
    }

    public var body: some View {
        VStack(alignment: .trailing, spacing: OrpheusSpacing.xs) {
            ForEach(items) { item in
                OrpheusToast(
                    item.message,
                    kind: item.kind,
                    title: item.title,
                    icon: item.icon,
                    onDismiss: item.onDismiss
                )
                .transition(
                    .asymmetric(
                        insertion:  .move(edge: .trailing).combined(with: .opacity),
                        removal:    .move(edge: .trailing).combined(with: .opacity)
                    )
                )
            }
        }
        .animation(OrpheusMotion.standardAnim, value: items.map(\.id))
    }
}

// MARK: - Previews

#Preview("Toast · dark") {
    toastPreview().orpheusTheme(.dark)
}

#Preview("Toast · light") {
    toastPreview().orpheusTheme(.light)
}

@MainActor
private func toastPreview() -> some View {
    VStack(alignment: .trailing, spacing: OrpheusSpacing.sm) {
        OrpheusToast("Connected to Anthropic API.", kind: .success, title: "Connected",
                     onDismiss: {})
        OrpheusToast("Session file not found.", kind: .critical, title: "Session failed to resume",
                     onDismiss: {})
        OrpheusToast("Rate limit approaching. Slow down requests.", kind: .warning,
                     onDismiss: {})
        OrpheusToast("Tip: press ⌘K to open the command palette.", kind: .info,
                     onDismiss: {})

        Spacer().frame(height: OrpheusSpacing.xs)
        OrpheusText("Stack (3 toasts)", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)
        OrpheusToastStack([
            OrpheusToastItem("Build finished in 2.3 s.", kind: .success, title: "Build OK"),
            OrpheusToastItem("Linter found 3 warnings.", kind: .warning),
            OrpheusToastItem("Could not reach GitHub. Check network.", kind: .critical,
                             title: "Network error"),
        ])
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 440, alignment: .trailing)
    .orpheusBackground(OrpheusColor.Surface.base)
}
