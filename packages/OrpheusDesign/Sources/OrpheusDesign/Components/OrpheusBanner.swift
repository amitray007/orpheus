import SwiftUI

/// Persistent inline banner. Sits inside a content area (not floating).
/// Matches the W19 error-banner pattern.
///
/// The banner stays visible until the caller removes it from the hierarchy.
/// A leading 4-pt colored stripe reinforces the severity. Background is a
/// tinted `Surface.elevated` blended with the kind color at 8% opacity.
public struct OrpheusBanner: View {

    public enum Kind: Sendable, Equatable {
        case info, success, warning, critical
    }

    /// Optional primary CTA rendered as an `OrpheusButton(.tertiary, .small)`.
    public struct Action: Sendable {
        public let title: String
        public let handler: @Sendable () -> Void

        public init(title: String, handler: @escaping @Sendable () -> Void) {
            self.title   = title
            self.handler = handler
        }
    }

    private let message: String
    private let kind: Kind
    private let title: String?
    private let icon: OrpheusIcon?
    private let isDismissable: Bool
    private let primaryAction: Action?
    private let onDismiss: (() -> Void)?

    @Environment(\.orpheusTheme) private var theme

    public init(
        _ message: String,
        kind: Kind = .info,
        title: String? = nil,
        icon: OrpheusIcon? = nil,
        isDismissable: Bool = true,
        primaryAction: Action? = nil,
        onDismiss: (() -> Void)? = nil
    ) {
        self.message       = message
        self.kind          = kind
        self.title         = title
        self.icon          = icon
        self.isDismissable = isDismissable
        self.primaryAction = primaryAction
        self.onDismiss     = onDismiss
    }

    public var body: some View {
        ZStack(alignment: .leading) {
            // Base + kind tint blend
            RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                .fill(surfaceColor)
            RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                .fill(kindTintColor.opacity(0.08))

            // Kind-color border
            RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                .strokeBorder(kindColor.opacity(0.30), lineWidth: 1)

            // Leading stripe + content
            HStack(alignment: .top, spacing: OrpheusSpacing.sm) {
                // 4pt-wide stripe
                RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                    .fill(kindColor)
                    .frame(width: 4)
                    .padding(.vertical, OrpheusSpacing.xxs)

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

                // Trailing: primary action + dismiss
                HStack(spacing: OrpheusSpacing.xs) {
                    if let primaryAction {
                        OrpheusButton(
                            primaryAction.title,
                            variant: .tertiary,
                            size: .small,
                            action: primaryAction.handler
                        )
                    }
                    if isDismissable, let onDismiss {
                        dismissButton(action: onDismiss)
                    }
                }
            }
            .padding(OrpheusSpacing.md)
        }
        .frame(maxWidth: .infinity)
        .fixedSize(horizontal: false, vertical: true)
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
        case .info:     return OrpheusIconSlot.info(color: semanticColor)
        case .success:  return OrpheusIconSlot.success(color: semanticColor)
        case .warning:  return OrpheusIconSlot.warning(color: semanticColor)
        case .critical: return OrpheusIconSlot.critical(color: semanticColor)
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

    // MARK: - Color resolution

    // Semantic token for this kind — used for icon + stripe.
    private var semanticColor: OrpheusThemedColor {
        switch kind {
        case .info:     return OrpheusColor.Semantic.info
        case .success:  return OrpheusColor.Semantic.success
        case .warning:  return OrpheusColor.Semantic.warning
        case .critical: return OrpheusColor.Semantic.critical
        }
    }

    private var kindColor: Color {
        theme.scheme == .dark ? semanticColor.darkColor : semanticColor.lightColor
    }

    // Pure kind color used for tinting the background
    private var kindTintColor: Color { kindColor }

    private var surfaceColor: Color {
        theme.scheme == .dark
            ? OrpheusColor.Surface.elevated.darkColor
            : OrpheusColor.Surface.elevated.lightColor
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

// MARK: - Previews

#Preview("Banner · dark") {
    bannerPreview().orpheusTheme(.dark)
}

#Preview("Banner · light") {
    bannerPreview().orpheusTheme(.light)
}

@MainActor
private func bannerPreview() -> some View {
    VStack(spacing: OrpheusSpacing.sm) {
        OrpheusBanner(
            "This is for your information.",
            kind: .info,
            title: "Heads up",
            primaryAction: .init(title: "Learn more") {},
            onDismiss: {}
        )
        OrpheusBanner(
            "Your session was saved successfully.",
            kind: .success,
            title: "Saved",
            primaryAction: .init(title: "View session") {},
            onDismiss: {}
        )
        OrpheusBanner(
            "Rate limit approaching. Slow down requests to avoid throttling.",
            kind: .warning,
            title: "Rate limit warning",
            primaryAction: .init(title: "Open settings") {},
            onDismiss: {}
        )
        OrpheusBanner(
            "Can't reach Anthropic API. Check your network or API key.",
            kind: .critical,
            title: "Connection error",
            primaryAction: .init(title: "Retry") {},
            onDismiss: {}
        )
        // Non-dismissable variant
        OrpheusBanner(
            "Running in offline mode — cached sessions only.",
            kind: .warning,
            isDismissable: false
        )
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 520, alignment: .leading)
    .orpheusBackground(OrpheusColor.Surface.base)
}
