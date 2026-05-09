import SwiftUI

/// View-modifier conveniences for the rest of the package (and consumer
/// modules) to apply `OrpheusDesign` tokens. Every token consumed by a
/// component should go through one of these — never a bare
/// `.foregroundStyle(.white)` or `.font(.system(...))`.

public extension View {

    /// Foreground colour from an `OrpheusThemedColor` token. Reads the
    /// active `OrpheusTheme` so both the system colour scheme and an
    /// explicit `orpheusTheme(_:)` override resolve correctly.
    func orpheusForeground(_ color: OrpheusThemedColor) -> some View {
        modifier(OrpheusForegroundModifier(color: color))
    }

    /// Background colour from an `OrpheusThemedColor` token.
    func orpheusBackground(_ color: OrpheusThemedColor) -> some View {
        modifier(OrpheusBackgroundModifier(color: color))
    }

    /// Add a 1-pt border using the given token, with a token-driven
    /// corner radius. Pass `OrpheusRadius.pill` to get half-height
    /// rounding (the radius is resolved against the view's actual
    /// height).
    func orpheusBorder(_ color: OrpheusThemedColor,
                       width: CGFloat = 1,
                       cornerRadius: CGFloat = 0) -> some View {
        modifier(OrpheusBorderModifier(color: color,
                                       width: width,
                                       cornerRadius: cornerRadius))
    }

    /// Apply a typography token: font, line spacing, tracking — all in
    /// one modifier so call sites stay one line.
    func orpheusFont(_ style: OrpheusTypography.Style) -> some View {
        font(style.font)
            .lineSpacing(style.lineSpacing)
            .tracking(style.tracking)
    }

    /// Apply a corner radius from the token scale; pass
    /// `OrpheusRadius.pill` to clamp to half-height at draw time.
    func orpheusCornerRadius(_ radius: CGFloat) -> some View {
        modifier(OrpheusCornerRadiusModifier(radius: radius))
    }
}

// MARK: - Modifier impls

private struct OrpheusForegroundModifier: ViewModifier {
    let color: OrpheusThemedColor
    @Environment(\.orpheusTheme) private var theme

    func body(content: Content) -> some View {
        content.foregroundStyle(theme.scheme == .dark ? color.darkColor : color.lightColor)
    }
}

private struct OrpheusBackgroundModifier: ViewModifier {
    let color: OrpheusThemedColor
    @Environment(\.orpheusTheme) private var theme

    func body(content: Content) -> some View {
        content.background(theme.scheme == .dark ? color.darkColor : color.lightColor)
    }
}

private struct OrpheusBorderModifier: ViewModifier {
    let color: OrpheusThemedColor
    let width: CGFloat
    let cornerRadius: CGFloat
    @Environment(\.orpheusTheme) private var theme

    func body(content: Content) -> some View {
        content.overlay(
            GeometryReader { proxy in
                let radius = OrpheusRadius.resolved(cornerRadius, forHeight: proxy.size.height)
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        theme.scheme == .dark ? color.darkColor : color.lightColor,
                        lineWidth: width
                    )
            }
        )
    }
}

private struct OrpheusCornerRadiusModifier: ViewModifier {
    let radius: CGFloat

    func body(content: Content) -> some View {
        GeometryReader { proxy in
            let resolved = OrpheusRadius.resolved(radius, forHeight: proxy.size.height)
            content.clipShape(RoundedRectangle(cornerRadius: resolved, style: .continuous))
        }
    }
}
