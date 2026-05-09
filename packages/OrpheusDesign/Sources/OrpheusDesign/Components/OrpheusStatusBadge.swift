import SwiftUI

/// Compact pill chip surfacing a semantic status. Supports filled, soft, and
/// outline presentation styles across six semantic kinds plus live/dormant
/// indicator variants.
public struct OrpheusStatusBadge: View {

    public enum Kind: Sendable, Equatable {
        case neutral
        case info
        case success
        case warning
        case critical
        case accent
        case live       // pulsing dot + accent.primary
        case dormant    // static dot + text.tertiary
    }

    public enum BadgeStyle: Sendable, Equatable {
        case filled     // colored background, text.inverted
        case soft       // 12 % tinted background, colored text
        case outline    // 1pt border, transparent fill, colored text
    }

    private let label: String
    private let kind: Kind
    private let style: BadgeStyle

    @State private var pulseOpacity: Double = 1.0

    @Environment(\.orpheusTheme) private var theme

    public init(
        _ label: String,
        kind: Kind,
        style: BadgeStyle = .filled
    ) {
        self.label = label
        self.kind = kind
        self.style = style
    }

    public var body: some View {
        HStack(spacing: OrpheusSpacing.xxs) {
            if kind == .live || kind == .dormant {
                Circle()
                    .frame(width: 6, height: 6)
                    .foregroundStyle(dotColor)
                    .opacity(kind == .live ? pulseOpacity : 1.0)
                    .onAppear {
                        guard kind == .live else { return }
                        withAnimation(
                            .easeInOut(duration: 1).repeatForever(autoreverses: true)
                        ) {
                            pulseOpacity = 0.4
                        }
                    }
                    .accessibilityHidden(true)
            }

            Text(label)
                .orpheusFont(OrpheusTypography.caption)
                .foregroundStyle(textColor)
        }
        .padding(.vertical, 6)
        .padding(.horizontal, OrpheusSpacing.xs)
        .background(backgroundView)
        .overlay(borderOverlay)
        .accessibilityLabel(accessibilityDescription)
        .accessibilityAddTraits(.isStaticText)
    }

    // MARK: - Color resolution

    /// The main semantic color for this kind.
    private var semanticColor: Color {
        let isDark = theme.scheme == .dark
        switch kind {
        case .neutral:
            return isDark
                ? OrpheusColor.Border.subtle.darkColor
                : OrpheusColor.Border.subtle.lightColor
        case .info:
            return isDark
                ? OrpheusColor.Semantic.info.darkColor
                : OrpheusColor.Semantic.info.lightColor
        case .success:
            return isDark
                ? OrpheusColor.Semantic.success.darkColor
                : OrpheusColor.Semantic.success.lightColor
        case .warning:
            return isDark
                ? OrpheusColor.Semantic.warning.darkColor
                : OrpheusColor.Semantic.warning.lightColor
        case .critical:
            return isDark
                ? OrpheusColor.Semantic.critical.darkColor
                : OrpheusColor.Semantic.critical.lightColor
        case .accent, .live:
            return isDark
                ? OrpheusColor.Accent.primary.darkColor
                : OrpheusColor.Accent.primary.lightColor
        case .dormant:
            return isDark
                ? OrpheusColor.Text.tertiary.darkColor
                : OrpheusColor.Text.tertiary.lightColor
        }
    }

    private var textColor: Color {
        let isDark = theme.scheme == .dark
        switch style {
        case .filled:
            return isDark
                ? OrpheusColor.Text.inverted.darkColor
                : OrpheusColor.Text.inverted.lightColor
        case .soft, .outline:
            // .neutral uses text.secondary; dormant uses text.tertiary
            switch kind {
            case .neutral:
                return isDark
                    ? OrpheusColor.Text.secondary.darkColor
                    : OrpheusColor.Text.secondary.lightColor
            case .dormant:
                return isDark
                    ? OrpheusColor.Text.tertiary.darkColor
                    : OrpheusColor.Text.tertiary.lightColor
            default:
                return semanticColor
            }
        }
    }

    private var dotColor: Color {
        let isDark = theme.scheme == .dark
        switch kind {
        case .live:
            return isDark
                ? OrpheusColor.Accent.primary.darkColor
                : OrpheusColor.Accent.primary.lightColor
        default: // .dormant
            return isDark
                ? OrpheusColor.Text.tertiary.darkColor
                : OrpheusColor.Text.tertiary.lightColor
        }
    }

    // MARK: - Background & border

    @ViewBuilder
    private var backgroundView: some View {
        switch style {
        case .filled:
            RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                .fill(semanticColor)
        case .soft:
            // 12 % tint of the semantic color over clear
            RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                .fill(semanticColor.opacity(0.12))
        case .outline:
            Color.clear
        }
    }

    @ViewBuilder
    private var borderOverlay: some View {
        if style == .outline {
            RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                .strokeBorder(semanticColor, lineWidth: 1)
        }
    }

    private var accessibilityDescription: String {
        switch kind {
        case .live:    return "\(label), live"
        case .dormant: return "\(label), dormant"
        default:       return label
        }
    }
}

// MARK: - Previews

#Preview("Badge matrix · dark") {
    badgeMatrix().orpheusTheme(.dark)
}

#Preview("Badge matrix · light") {
    badgeMatrix().orpheusTheme(.light)
}

@MainActor
private func badgeMatrix() -> some View {
    let kinds: [(String, OrpheusStatusBadge.Kind)] = [
        ("neutral",  .neutral),
        ("info",     .info),
        ("success",  .success),
        ("warning",  .warning),
        ("critical", .critical),
        ("accent",   .accent),
        ("live",     .live),
        ("dormant",  .dormant),
    ]
    let styles: [(String, OrpheusStatusBadge.BadgeStyle)] = [
        ("filled",  .filled),
        ("soft",    .soft),
        ("outline", .outline),
    ]

    return VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
        // Header row
        HStack(spacing: OrpheusSpacing.xs) {
            OrpheusText("", style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary)
                .frame(width: 72, alignment: .leading)
            ForEach(styles, id: \.0) { name, _ in
                OrpheusText(name, style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                    .frame(width: 80, alignment: .center)
            }
        }
        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)

        ForEach(kinds, id: \.0) { kindName, kind in
            HStack(spacing: OrpheusSpacing.xs) {
                OrpheusText(kindName, style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                    .frame(width: 72, alignment: .leading)
                ForEach(styles, id: \.0) { _, style in
                    OrpheusStatusBadge(kindName, kind: kind, style: style)
                        .frame(width: 80, alignment: .center)
                }
            }
        }
    }
    .padding(OrpheusSpacing.lg)
    .orpheusBackground(OrpheusColor.Surface.base)
}
