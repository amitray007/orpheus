import SwiftUI

/// Structured row primitive matching the wireframe row pattern: leading icon,
/// title + optional subtitle, trailing accessories, optional disclosure chevron.
///
/// The `trailingBadge` parameter accepts `AnyView?` rather than
/// `OrpheusStatusBadge?` to keep this component self-contained — callers wrap
/// with `AnyView(OrpheusStatusBadge(...))` when they want a typed badge.
public struct OrpheusRow: View {

    private let title: String
    private let subtitle: String?
    private let leading: OrpheusIcon?
    private let trailingBadge: AnyView?
    private let trailing: AnyView?
    private let showsDisclosure: Bool
    private let isSelected: Bool
    private let onTap: (() -> Void)?

    @State private var isHovered = false
    @Environment(\.orpheusTheme) private var theme

    public init(
        _ title: String,
        subtitle: String? = nil,
        leading: OrpheusIcon? = nil,
        trailingBadge: AnyView? = nil,
        trailing: AnyView? = nil,
        showsDisclosure: Bool = false,
        isSelected: Bool = false,
        onTap: (() -> Void)? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.leading = leading
        self.trailingBadge = trailingBadge
        self.trailing = trailing
        self.showsDisclosure = showsDisclosure
        self.isSelected = isSelected
        self.onTap = onTap
    }

    public var body: some View {
        HStack(spacing: OrpheusSpacing.xs) {
            if let leading {
                leading
                    .frame(width: OrpheusSpacing.md, height: OrpheusSpacing.md)
            }

            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .orpheusFont(OrpheusTypography.body)
                    .orpheusForeground(OrpheusColor.Text.primary)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .orpheusFont(OrpheusTypography.caption)
                        .orpheusForeground(OrpheusColor.Text.tertiary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let badge = trailingBadge {
                badge
            }
            if let trailing {
                trailing
            }
            if showsDisclosure {
                OrpheusIconSlot.chevronClosed(
                    size: .small,
                    color: OrpheusColor.Text.tertiary
                )
                .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, OrpheusSpacing.sm)
        .padding(.vertical, OrpheusSpacing.xxs)
        .frame(minHeight: 32)
        .background(rowBackground)
        .contentShape(Rectangle())
        .onHover { hovering in
            withAnimation(OrpheusMotion.quickAnim) { isHovered = hovering }
        }
        .onTapGesture { onTap?() }
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var rowBackground: Color {
        let isDark = theme.scheme == .dark
        if isSelected {
            let token = OrpheusColor.Accent.subtle
            return isDark ? token.darkColor : token.lightColor
        }
        if isHovered {
            let token = OrpheusColor.Surface.elevated
            return isDark ? token.darkColor : token.lightColor
        }
        return .clear
    }

    private var accessibilityLabel: String {
        var parts = [title]
        if let subtitle { parts.append(subtitle) }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Previews

#Preview("Row matrix · dark") {
    rowMatrix().orpheusTheme(.dark)
}

#Preview("Row matrix · light") {
    rowMatrix().orpheusTheme(.light)
}

@MainActor
private func rowMatrix() -> some View {
    VStack(spacing: 0) {
        OrpheusRow(
            "Title only"
        )
        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)
        OrpheusRow(
            "With leading icon",
            leading: OrpheusIcon(systemName: "folder", size: .medium,
                                 color: OrpheusColor.Text.secondary)
        )
        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)
        OrpheusRow(
            "Title and subtitle",
            subtitle: "Supporting metadata here",
            leading: OrpheusIcon(systemName: "terminal", size: .medium,
                                 color: OrpheusColor.Text.secondary)
        )
        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)
        OrpheusRow(
            "With disclosure chevron",
            subtitle: "Expandable row",
            showsDisclosure: true
        )
        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)
        OrpheusRow(
            "Selected row",
            subtitle: "accent.subtle background",
            leading: OrpheusIcon(systemName: "star.fill", size: .medium,
                                 color: OrpheusColor.Accent.primary),
            isSelected: true
        )
        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)
        OrpheusRow(
            "Trailing badge",
            trailingBadge: AnyView(
                OrpheusStatusBadge("live", kind: .live, style: .soft)
            )
        )
        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)
        OrpheusRow(
            "Full kit",
            subtitle: "Icon · badge · extra · chevron",
            leading: OrpheusIcon(systemName: "sparkles", size: .medium,
                                 color: OrpheusColor.Accent.primary),
            trailingBadge: AnyView(
                OrpheusStatusBadge("3", kind: .accent, style: .soft)
            ),
            trailing: AnyView(
                OrpheusText("5d", style: OrpheusTypography.caption,
                             color: OrpheusColor.Text.tertiary)
            ),
            showsDisclosure: true
        )
    }
    .frame(width: 320)
    .orpheusBackground(OrpheusColor.Surface.base)
}
