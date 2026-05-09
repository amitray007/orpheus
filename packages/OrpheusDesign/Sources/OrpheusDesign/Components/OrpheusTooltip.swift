import SwiftUI

// MARK: - Placement

public enum OrpheusTooltipPlacement: Sendable, Equatable {
    case above, below, leading, trailing
}

// MARK: - Tooltip bubble (composable standalone view)

/// The tooltip bubble view — useful for catalog rendering and manual composition.
/// In normal usage the `.orpheusTooltip(_:placement:)` modifier should be preferred.
public struct OrpheusTooltip: View {

    private let text: String

    public init(_ text: String) {
        self.text = text
    }

    public var body: some View {
        Text(text)
            .orpheusFont(OrpheusTypography.caption)
            .orpheusForeground(OrpheusColor.Text.primary)
            .padding(.vertical, OrpheusSpacing.xxs)
            .padding(.horizontal, OrpheusSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                    .fill(backgroundFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: 1)
            )
            .accessibilityLabel(text)
            .accessibilityHidden(true) // decorative from the trigger view's perspective
    }

    @Environment(\.orpheusTheme) private var theme

    private var backgroundFill: Color {
        theme.scheme == .dark
            ? OrpheusColor.Surface.overlay.darkColor
            : OrpheusColor.Surface.overlay.lightColor
    }

    private var borderColor: Color {
        theme.scheme == .dark
            ? OrpheusColor.Border.default.darkColor
            : OrpheusColor.Border.default.lightColor
    }
}

// MARK: - Hover modifier

public extension View {
    /// Attaches a tooltip that appears after a 500 ms hover delay and disappears
    /// immediately on hover-out.
    func orpheusTooltip(
        _ text: String,
        placement: OrpheusTooltipPlacement = .below
    ) -> some View {
        modifier(OrpheusTooltipModifier(text: text, placement: placement))
    }
}

// MARK: - Modifier implementation

private struct OrpheusTooltipModifier: ViewModifier {

    let text: String
    let placement: OrpheusTooltipPlacement

    @State private var isVisible: Bool = false
    @State private var showTask: Task<Void, Never>? = nil

    func body(content: Content) -> some View {
        content
            .onHover { hovering in
                if hovering {
                    showTask = Task {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        guard !Task.isCancelled else { return }
                        withAnimation(OrpheusMotion.quickAnim) {
                            isVisible = true
                        }
                    }
                } else {
                    showTask?.cancel()
                    showTask = nil
                    // Hide instantly on hover-out (no animation delay)
                    isVisible = false
                }
            }
            .popover(isPresented: $isVisible, attachmentAnchor: anchor, arrowEdge: arrowEdge) {
                OrpheusTooltip(text)
                    .padding(OrpheusSpacing.xxs)
                    // popover inherits system background; override with a clear host
                    // so our bubble renders its own surface cleanly.
                    .background(Color.clear)
            }
    }

    private var anchor: PopoverAttachmentAnchor {
        switch placement {
        case .above:    return .rect(.bounds)
        case .below:    return .rect(.bounds)
        case .leading:  return .rect(.bounds)
        case .trailing: return .rect(.bounds)
        }
    }

    private var arrowEdge: Edge {
        switch placement {
        case .above:    return .bottom
        case .below:    return .top
        case .leading:  return .trailing
        case .trailing: return .leading
        }
    }
}

// MARK: - Previews

#Preview("Tooltip bubbles · dark") {
    tooltipPreview().orpheusTheme(.dark)
}

#Preview("Tooltip bubbles · light") {
    tooltipPreview().orpheusTheme(.light)
}

/// Static bubble catalog — hover doesn't fire in previews so we show the
/// bubble view directly for each placement label.
@MainActor
private func tooltipPreview() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.lg) {
        // Static bubbles
        VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
            OrpheusText("Tooltip bubble (static)",
                        style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary)
            HStack(spacing: OrpheusSpacing.sm) {
                OrpheusTooltip("Above the trigger")
                OrpheusTooltip("Below the trigger")
                OrpheusTooltip("Leading side")
                OrpheusTooltip("Trailing side")
            }
        }

        // Live trigger targets (hover in a running app to activate)
        VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
            OrpheusText("Hover targets (hover in running app)",
                        style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary)
            HStack(spacing: OrpheusSpacing.sm) {
                triggerChip("Above", tip: "Opens above", placement: .above)
                triggerChip("Below", tip: "Opens below", placement: .below)
                triggerChip("Leading", tip: "Opens on the left", placement: .leading)
                triggerChip("Trailing", tip: "Opens on the right", placement: .trailing)
            }
        }
    }
    .padding(OrpheusSpacing.lg)
    .orpheusBackground(OrpheusColor.Surface.base)
}

@MainActor
private func triggerChip(
    _ label: String,
    tip: String,
    placement: OrpheusTooltipPlacement
) -> some View {
    Text(label)
        .orpheusFont(OrpheusTypography.caption)
        .orpheusForeground(OrpheusColor.Text.secondary)
        .padding(.vertical, OrpheusSpacing.xxs)
        .padding(.horizontal, OrpheusSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                .fill(OrpheusColor.Surface.elevated.resolved)
        )
        .orpheusTooltip(tip, placement: placement)
}
