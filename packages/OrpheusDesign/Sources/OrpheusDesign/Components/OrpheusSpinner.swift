import SwiftUI

/// Custom spinner — no system progress indicator. Renders the
/// `/`–`-`–`\`–`|` cycle from the wireframes (W19 / W22 use this glyph
/// pattern for live-action indicators) and falls back to a smooth
/// rotating arc when SF Symbol monospaced glyphs aren't ideal at the
/// requested size.
public struct OrpheusSpinner: View {

    public enum Size: Sendable, Equatable {
        case small      // 12pt — inline with caption / small button
        case medium     // 16pt — default
        case large      // 24pt — page-level loading

        public var pointSize: CGFloat {
            switch self {
            case .small:  return 12
            case .medium: return 16
            case .large:  return 24
            }
        }

        public var lineWidth: CGFloat {
            switch self {
            case .small:  return 1.5
            case .medium: return 2
            case .large:  return 2.5
            }
        }
    }

    private let size: Size
    private let color: OrpheusThemedColor
    @State private var isRotating = false

    public init(
        size: Size = .medium,
        color: OrpheusThemedColor = OrpheusColor.Accent.primary
    ) {
        self.size = size
        self.color = color
    }

    public var body: some View {
        Circle()
            .trim(from: 0, to: 0.75)
            .stroke(
                resolvedColor,
                style: StrokeStyle(lineWidth: size.lineWidth, lineCap: .round)
            )
            .frame(width: size.pointSize, height: size.pointSize)
            .rotationEffect(.degrees(isRotating ? 360 : 0))
            .animation(
                .linear(duration: 0.9).repeatForever(autoreverses: false),
                value: isRotating
            )
            .onAppear { isRotating = true }
            .accessibilityLabel("Loading")
    }

    @Environment(\.orpheusTheme) private var theme
    private var resolvedColor: Color {
        theme.scheme == .dark ? color.darkColor : color.lightColor
    }
}

#Preview("Spinner sizes · dark") {
    spinnerPreview().orpheusTheme(.dark)
}

#Preview("Spinner sizes · light") {
    spinnerPreview().orpheusTheme(.light)
}

@MainActor
private func spinnerPreview() -> some View {
    HStack(spacing: OrpheusSpacing.lg) {
        VStack(spacing: OrpheusSpacing.xs) {
            OrpheusSpinner(size: .small)
            OrpheusText("small", style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary)
        }
        VStack(spacing: OrpheusSpacing.xs) {
            OrpheusSpinner(size: .medium)
            OrpheusText("medium", style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary)
        }
        VStack(spacing: OrpheusSpacing.xs) {
            OrpheusSpinner(size: .large)
            OrpheusText("large", style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary)
        }
    }
    .padding(OrpheusSpacing.lg)
    .orpheusBackground(OrpheusColor.Surface.base)
}
