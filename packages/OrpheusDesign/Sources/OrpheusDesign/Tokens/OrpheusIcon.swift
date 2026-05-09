import SwiftUI

/// Icon system. Every icon rendered in Orpheus goes through `OrpheusIcon`
/// (or a token-named alias on this enum) — never a bare SF Symbol string,
/// never a raw `Image(systemName:)` outside this file.
///
/// Two reasons for the wrapping:
/// 1. Phase 7 swaps in custom-drawn glyphs for the Orpheus-specific
///    concepts (project, space, terminal, fork, self-drive). Routing
///    every call site through tokens means that swap is one-file.
/// 2. SF Symbol calls almost always need a paired weight + color (per
///    the discipline rules); a wrapper enforces that pairing so no
///    component leaks the system default tint.
public struct OrpheusIcon: View {

    public enum Source: Sendable, Equatable {
        case sfSymbol(String)
    }

    public enum Size: Sendable, Equatable {
        case small      // 14pt — inline with caption text
        case medium     // 16pt — default UI
        case large      // 20pt — section headers
        case xlarge     // 24pt — empty-state illustrations

        public var pointSize: CGFloat {
            switch self {
            case .small:  return 14
            case .medium: return 16
            case .large:  return 20
            case .xlarge: return 24
            }
        }
    }

    public let source: Source
    public let size: Size
    public let color: OrpheusThemedColor
    public let weight: Font.Weight

    public init(
        _ source: Source,
        size: Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.secondary,
        weight: Font.Weight = .medium
    ) {
        self.source = source
        self.size = size
        self.color = color
        self.weight = weight
    }

    public init(
        systemName: String,
        size: Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.secondary,
        weight: Font.Weight = .medium
    ) {
        self.init(.sfSymbol(systemName), size: size, color: color, weight: weight)
    }

    public var body: some View {
        switch source {
        case .sfSymbol(let name):
            Image(systemName: name)
                .font(.system(size: size.pointSize, weight: weight))
                .foregroundStyle(color.resolved)
                .accessibilityHidden(true)
        }
    }
}

/// Named slots for Orpheus-specific concepts. v0 maps each to an SF Symbol
/// placeholder; Phase 7 replaces the implementations with custom-drawn
/// glyphs without touching call sites.
public enum OrpheusIconSlot {
    /// Project — a folder-like grouping at the top of the hierarchy.
    public static func project(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.secondary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "folder", size: size, color: color)
    }

    /// Space — the workspace unit inside a project.
    public static func space(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.secondary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "square.stack.3d.up", size: size, color: color)
    }

    /// Terminal — the leaf in the hierarchy.
    public static func terminal(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.secondary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "terminal", size: size, color: color)
    }

    /// Fork-to-pane — split with fork semantics.
    public static func fork(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.secondary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "arrow.triangle.branch", size: size, color: color)
    }

    /// Self-drive indicator — Claude is driving the UI.
    public static func selfDrive(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Accent.primary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "sparkles", size: size, color: color)
    }

    /// Search.
    public static func search(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.tertiary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "magnifyingglass", size: size, color: color)
    }

    /// Disclosure chevron — closed (collapsed) state.
    public static func chevronClosed(
        size: OrpheusIcon.Size = .small,
        color: OrpheusThemedColor = OrpheusColor.Text.tertiary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "chevron.right", size: size, color: color)
    }

    /// Disclosure chevron — open (expanded) state.
    public static func chevronOpen(
        size: OrpheusIcon.Size = .small,
        color: OrpheusThemedColor = OrpheusColor.Text.tertiary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "chevron.down", size: size, color: color)
    }

    /// Checkmark — toggle on / selected state.
    public static func check(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Accent.primary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "checkmark", size: size, color: color)
    }

    /// Close / dismiss.
    public static func close(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Text.secondary
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "xmark", size: size, color: color)
    }

    /// Warning / caution.
    public static func warning(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Semantic.warning
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "exclamationmark.triangle.fill",
                    size: size, color: color)
    }

    /// Critical / destructive.
    public static func critical(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Semantic.critical
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "xmark.octagon.fill", size: size, color: color)
    }

    /// Success / done.
    public static func success(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Semantic.success
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "checkmark.circle.fill", size: size, color: color)
    }

    /// Info.
    public static func info(
        size: OrpheusIcon.Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Semantic.info
    ) -> OrpheusIcon {
        OrpheusIcon(systemName: "info.circle.fill", size: size, color: color)
    }
}
