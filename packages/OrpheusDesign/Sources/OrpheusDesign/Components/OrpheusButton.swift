import SwiftUI

/// Custom-rendered button. Internally backed by SwiftUI's `Button` so we
/// inherit accessibility, focus, and the system tap pipeline — but every
/// pixel of the rendered chrome comes from `OrpheusDesign` tokens, so
/// nothing of the SwiftUI default style leaks through.
///
/// Variants: `primary`, `secondary`, `tertiary`, `destructive`, `ghost`.
/// Sizes: `small` (24pt), `medium` (28pt), `large` (32pt) — all on the
/// 4-pixel grid.
public struct OrpheusButton: View {

    public enum Variant: Sendable, Equatable {
        case primary       // gold accent, text.inverted
        case secondary     // surface.elevated, text.primary
        case tertiary      // transparent, accent text on hover
        case destructive   // semantic.critical
        case ghost         // transparent, text.secondary
    }

    public enum Size: Sendable, Equatable {
        case small, medium, large

        public var height: CGFloat {
            switch self {
            case .small:  return 24
            case .medium: return 28
            case .large:  return 32
            }
        }

        public var horizontalPadding: CGFloat {
            switch self {
            case .small:  return OrpheusSpacing.sm    // 12
            case .medium: return OrpheusSpacing.md    // 16
            case .large:  return OrpheusSpacing.md    // 16
            }
        }

        public var typography: OrpheusTypography.Style {
            switch self {
            case .small:  return OrpheusTypography.caption
            case .medium: return OrpheusTypography.body
            case .large:  return OrpheusTypography.heading
            }
        }
    }

    private let title: String
    private let leadingIcon: OrpheusIcon?
    private let trailingIcon: OrpheusIcon?
    private let variant: Variant
    private let size: Size
    private let isLoading: Bool
    private let isEnabled: Bool
    private let action: () -> Void

    @State private var isHovered = false
    @State private var isPressed = false

    public init(
        _ title: String,
        leadingIcon: OrpheusIcon? = nil,
        trailingIcon: OrpheusIcon? = nil,
        variant: Variant = .primary,
        size: Size = .medium,
        isLoading: Bool = false,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.leadingIcon = leadingIcon
        self.trailingIcon = trailingIcon
        self.variant = variant
        self.size = size
        self.isLoading = isLoading
        self.isEnabled = isEnabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: OrpheusSpacing.xs) {
                if isLoading {
                    OrpheusSpinner(size: spinnerSize, color: foregroundColor)
                } else if let leadingIcon {
                    leadingIcon
                }
                Text(title)
                    .orpheusFont(size.typography)
                    .orpheusForeground(foregroundColor)
                    .fixedSize(horizontal: true, vertical: false)
                if let trailingIcon, !isLoading {
                    trailingIcon
                }
            }
            .padding(.horizontal, size.horizontalPadding)
            .frame(height: size.height)
            .background(
                RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous)
                    .fill(backgroundFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: borderWidth)
            )
            .opacity(isEnabled ? 1.0 : 0.5)
            .contentShape(RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled || isLoading)
        .onHover { hovering in
            withAnimation(OrpheusMotion.quickAnim) {
                isHovered = hovering && isEnabled && !isLoading
            }
        }
        .scaleEffect(isPressed ? 0.97 : 1.0)
        .animation(OrpheusMotion.quickAnim, value: isPressed)
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in isPressed = isEnabled && !isLoading }
                .onEnded   { _ in isPressed = false }
        )
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Style resolution

    private var spinnerSize: OrpheusSpinner.Size {
        switch size {
        case .small:  return .small
        case .medium: return .small
        case .large:  return .medium
        }
    }

    private var foregroundColor: OrpheusThemedColor {
        switch variant {
        case .primary, .destructive:
            return OrpheusColor.Text.inverted
        case .secondary:
            return OrpheusColor.Text.primary
        case .tertiary:
            return isHovered
                ? OrpheusColor.Accent.hover
                : OrpheusColor.Accent.primary
        case .ghost:
            return isHovered
                ? OrpheusColor.Text.primary
                : OrpheusColor.Text.secondary
        }
    }

    private var backgroundFill: Color {
        let isDark = currentScheme == .dark
        switch variant {
        case .primary:
            let token = isPressed ? OrpheusColor.Accent.pressed
                       : isHovered ? OrpheusColor.Accent.hover
                                   : OrpheusColor.Accent.primary
            return isDark ? token.darkColor : token.lightColor
        case .secondary:
            let token = isHovered
                ? OrpheusColor.Surface.overlay
                : OrpheusColor.Surface.elevated
            return isDark ? token.darkColor : token.lightColor
        case .destructive:
            let crit = OrpheusColor.Semantic.critical
            return isDark ? crit.darkColor : crit.lightColor
        case .tertiary, .ghost:
            if isHovered {
                let subtle = OrpheusColor.Accent.subtle
                return isDark ? subtle.darkColor : subtle.lightColor
            }
            return .clear
        }
    }

    private var borderColor: Color {
        let isDark = currentScheme == .dark
        switch variant {
        case .secondary:
            let token = isHovered ? OrpheusColor.Border.default
                                  : OrpheusColor.Border.subtle
            return isDark ? token.darkColor : token.lightColor
        default:
            return .clear
        }
    }

    private var borderWidth: CGFloat {
        variant == .secondary ? 1 : 0
    }

    @Environment(\.orpheusTheme) private var theme
    private var currentScheme: ColorScheme { theme.scheme }
}

#Preview("Button matrix · dark") {
    buttonMatrix().orpheusTheme(.dark)
}
#Preview("Button matrix · light") {
    buttonMatrix().orpheusTheme(.light)
}

@MainActor
private func buttonMatrix() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
        ForEach([
            ("primary",     OrpheusButton.Variant.primary),
            ("secondary",   .secondary),
            ("tertiary",    .tertiary),
            ("destructive", .destructive),
            ("ghost",       .ghost)
        ], id: \.0) { name, variant in
            HStack(spacing: OrpheusSpacing.sm) {
                OrpheusText(name,
                            style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                    .frame(width: 88, alignment: .leading)
                OrpheusButton("Small",  variant: variant, size: .small)  { }
                OrpheusButton("Medium", variant: variant, size: .medium) { }
                OrpheusButton("Large",  variant: variant, size: .large)  { }
                OrpheusButton("Loading…", variant: variant, isLoading: true) { }
                OrpheusButton("Off", variant: variant, isEnabled: false) { }
            }
        }
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 720, alignment: .leading)
    .orpheusBackground(OrpheusColor.Surface.base)
}
