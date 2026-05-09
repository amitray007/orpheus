import SwiftUI

/// Token-bound text view. Replaces `Text(...).font(.system(...))` at every
/// call site so the rule "every font goes through `OrpheusText` or the
/// typography tokens" is one wrap away.
public struct OrpheusText: View {
    private let content: String
    private let style: OrpheusTypography.Style
    private let color: OrpheusThemedColor
    private let alignment: TextAlignment

    public init(
        _ content: String,
        style: OrpheusTypography.Style = OrpheusTypography.body,
        color: OrpheusThemedColor = OrpheusColor.Text.primary,
        alignment: TextAlignment = .leading
    ) {
        self.content = content
        self.style = style
        self.color = color
        self.alignment = alignment
    }

    public var body: some View {
        Text(content)
            .multilineTextAlignment(alignment)
            .orpheusFont(style)
            .orpheusForeground(color)
            .accessibilityLabel(content)
    }
}

#Preview("Type ramp · dark") {
    rampPreview()
        .orpheusTheme(.dark)
}

#Preview("Type ramp · light") {
    rampPreview()
        .orpheusTheme(.light)
}

@MainActor
private func rampPreview() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
        OrpheusText("Display — hero",   style: OrpheusTypography.display)
        OrpheusText("Title — section",  style: OrpheusTypography.title)
        OrpheusText("Heading — subsection", style: OrpheusTypography.heading)
        OrpheusText("Body — default UI text",
                    style: OrpheusTypography.body,
                    color: OrpheusColor.Text.secondary)
        OrpheusText("Caption — metadata",
                    style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)
        OrpheusText("mono — terminal · code",
                    style: OrpheusTypography.mono)
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 420, alignment: .leading)
    .orpheusBackground(OrpheusColor.Surface.base)
}
