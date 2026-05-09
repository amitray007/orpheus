import SwiftUI

/// Visual pill chip for the Quick Actions footer strip. Displays an optional
/// glyph and a label; triggers a caller-supplied action on tap. Execution
/// semantics (agent dispatch, streaming, etc.) are Phase 4 concerns.
public struct OrpheusQuickAction: View {

    public enum Kind: Sendable, Equatable {
        case standard   // surface.elevated bg, text.primary
        case primary    // accent.primary bg, text.inverted
        case ghost      // transparent bg, text.secondary; accent.subtle on hover
    }

    private let label: String
    private let glyph: OrpheusIcon?
    private let kind: Kind
    private let isEnabled: Bool
    private let action: () -> Void

    @State private var isHovered = false
    @State private var isPressed = false

    @Environment(\.orpheusTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        _ label: String,
        glyph: OrpheusIcon? = nil,
        kind: Kind = .standard,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.label = label
        self.glyph = glyph
        self.kind = kind
        self.isEnabled = isEnabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: OrpheusSpacing.xxs) {
                if let glyph {
                    glyph
                        .accessibilityHidden(true) // label already covers meaning
                }
                Text(label)
                    .orpheusFont(OrpheusTypography.caption)
                    .foregroundStyle(resolvedTextColor)
                    .fixedSize()
            }
            .padding(.horizontal, OrpheusSpacing.sm)
            .frame(height: 24)
            .background(
                Capsule(style: .continuous)
                    .fill(resolvedBackground)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(borderColor, lineWidth: borderWidth)
            )
            .opacity(isEnabled ? 1.0 : 0.5)
            .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .scaleEffect(isPressed ? 0.97 : 1.0)
        .animation(reduceMotion ? .none : OrpheusMotion.quickAnim, value: isPressed)
        .onHover { hovering in
            guard isEnabled else { return }
            if reduceMotion {
                isHovered = hovering
            } else {
                withAnimation(OrpheusMotion.quickAnim) {
                    isHovered = hovering
                }
            }
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in isPressed = isEnabled }
                .onEnded   { _ in isPressed = false }
        )
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Style resolution

    private var isDark: Bool { theme.scheme == .dark }

    private var resolvedBackground: Color {
        switch kind {
        case .standard:
            let token = isHovered
                ? OrpheusColor.Surface.overlay
                : OrpheusColor.Surface.elevated
            return isDark ? token.darkColor : token.lightColor
        case .primary:
            let token = isPressed ? OrpheusColor.Accent.pressed
                       : isHovered ? OrpheusColor.Accent.hover
                                   : OrpheusColor.Accent.primary
            return isDark ? token.darkColor : token.lightColor
        case .ghost:
            if isHovered {
                let subtle = OrpheusColor.Accent.subtle
                return (isDark ? subtle.darkColor : subtle.lightColor)
            }
            return .clear
        }
    }

    private var resolvedTextColor: Color {
        switch kind {
        case .primary:
            return isDark
                ? OrpheusColor.Text.inverted.darkColor
                : OrpheusColor.Text.inverted.lightColor
        case .standard:
            return isDark
                ? OrpheusColor.Text.primary.darkColor
                : OrpheusColor.Text.primary.lightColor
        case .ghost:
            return isHovered
                ? (isDark ? OrpheusColor.Accent.primary.darkColor : OrpheusColor.Accent.primary.lightColor)
                : (isDark ? OrpheusColor.Text.secondary.darkColor : OrpheusColor.Text.secondary.lightColor)
        }
    }

    /// Subtle border for `.standard` chips so they read on surface.base.
    private var borderColor: Color {
        guard kind == .standard else { return .clear }
        let token = isHovered ? OrpheusColor.Border.default : OrpheusColor.Border.subtle
        return isDark ? token.darkColor : token.lightColor
    }

    private var borderWidth: CGFloat { kind == .standard ? 1 : 0 }
}

// MARK: - Previews

#Preview("Quick actions · dark") {
    quickActionStrip().orpheusTheme(.dark)
}

#Preview("Quick actions · light") {
    quickActionStrip().orpheusTheme(.light)
}

@MainActor
private func quickActionStrip() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
        OrpheusText("Standard", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)
        HStack(spacing: OrpheusSpacing.xs) {
            OrpheusQuickAction("Run tests") { }
            OrpheusQuickAction(
                "Commit",
                glyph: OrpheusIcon(systemName: "checkmark",
                                   size: .small,
                                   color: OrpheusColor.Text.secondary)
            ) { }
            OrpheusQuickAction("Disabled", isEnabled: false) { }
        }

        OrpheusText("Primary", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)
        HStack(spacing: OrpheusSpacing.xs) {
            OrpheusQuickAction("Apply", kind: .primary) { }
            OrpheusQuickAction(
                "Ship",
                glyph: OrpheusIcon(systemName: "paperplane.fill",
                                   size: .small,
                                   color: OrpheusColor.Text.inverted),
                kind: .primary
            ) { }
            OrpheusQuickAction("Disabled", kind: .primary, isEnabled: false) { }
        }

        OrpheusText("Ghost", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)
        HStack(spacing: OrpheusSpacing.xs) {
            OrpheusQuickAction("Dismiss", kind: .ghost) { }
            OrpheusQuickAction(
                "Settings",
                glyph: OrpheusIcon(systemName: "gearshape",
                                   size: .small,
                                   color: OrpheusColor.Text.secondary),
                kind: .ghost
            ) { }
            OrpheusQuickAction("Disabled", kind: .ghost, isEnabled: false) { }
        }

        // Strip simulation
        OrpheusText("As a strip", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: OrpheusSpacing.xs) {
                OrpheusQuickAction("Run tests", kind: .standard) { }
                OrpheusQuickAction(
                    "Commit",
                    glyph: OrpheusIcon(systemName: "checkmark",
                                       size: .small,
                                       color: OrpheusColor.Text.secondary)
                ) { }
                OrpheusQuickAction("Push", kind: .standard) { }
                OrpheusQuickAction(
                    "Apply all",
                    glyph: OrpheusIcon(systemName: "sparkles",
                                       size: .small,
                                       color: OrpheusColor.Text.inverted),
                    kind: .primary
                ) { }
                OrpheusQuickAction("Discard", kind: .ghost) { }
                OrpheusQuickAction("Format", kind: .ghost) { }
            }
        }
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 520, alignment: .leading)
    .orpheusBackground(OrpheusColor.Surface.base)
}
