import SwiftUI

/// A complete `OrpheusDesign` theme: a `ColorScheme` plus the LOCKED
/// palette for that scheme. Typography, spacing, radius, motion, and
/// material specs are scheme-independent so they live as static tokens
/// and aren't bundled here.
///
/// Two canonical instances ship with the package: `.dark` (the primary,
/// daily-driver default) and `.light`. Apps can construct an
/// `OrpheusTheme` directly from a custom palette later — useful for the
/// "user-defined themes" item flagged as a v1+ open decision in
/// `extras/specs/design-principles.md`.
public struct OrpheusTheme: Sendable {

    public let scheme: ColorScheme
    public let palette: OrpheusPalette

    public init(scheme: ColorScheme, palette: OrpheusPalette) {
        self.scheme = scheme
        self.palette = palette
    }

    public static let dark  = OrpheusTheme(scheme: .dark,  palette: .dark)
    public static let light = OrpheusTheme(scheme: .light, palette: .light)
}

private struct OrpheusThemeKey: EnvironmentKey {
    static let defaultValue: OrpheusTheme = .dark
}

public extension EnvironmentValues {
    /// The active theme. Defaults to `.dark`; consumers either rely on
    /// the `View.orpheusTheme(_:)` chain to set this, or read it directly
    /// when a component needs the raw palette (instead of an
    /// `OrpheusThemedColor`).
    var orpheusTheme: OrpheusTheme {
        get { self[OrpheusThemeKey.self] }
        set { self[OrpheusThemeKey.self] = newValue }
    }
}

public extension View {
    /// Apply an explicit `OrpheusTheme` to a sub-tree. Sets both the
    /// SwiftUI `colorScheme` and `orpheusTheme` environment values so
    /// every consumer (palette readers, `.orpheusForeground(_:)` etc.)
    /// and SwiftUI itself agree.
    ///
    /// Pass `nil` to fall back to the system colour scheme.
    func orpheusTheme(_ theme: OrpheusTheme?) -> some View {
        modifier(OrpheusThemeModifier(override: theme))
    }
}

private struct OrpheusThemeModifier: ViewModifier {
    let override: OrpheusTheme?
    @Environment(\.colorScheme) private var systemScheme

    func body(content: Content) -> some View {
        let resolved = override ?? OrpheusTheme(
            scheme: systemScheme,
            palette: systemScheme == .dark ? .dark : .light
        )
        let view = content
            .environment(\.orpheusTheme, resolved)
            .environment(\.colorScheme, resolved.scheme)
        if let override {
            return AnyView(view.preferredColorScheme(override.scheme))
        } else {
            return AnyView(view)
        }
    }
}
