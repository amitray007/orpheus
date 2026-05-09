import SwiftUI

/// Loading placeholder. Renders a rounded rectangle with a left-to-right
/// shimmer that signals "loading, not broken." Matches the W19 skeleton
/// pattern.
///
/// When `@Environment(\.accessibilityReduceMotion)` is `true` the shimmer
/// animation is suppressed; the static placeholder remains visible.
public struct OrpheusSkeleton: View {

    private let width: CGFloat?
    private let height: CGFloat
    private let cornerRadius: CGFloat

    @State private var shimmerOffset: CGFloat = -1.0
    @Environment(\.orpheusTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        width: CGFloat? = nil,
        height: CGFloat = 12,
        cornerRadius: CGFloat = OrpheusRadius.chip
    ) {
        self.width = width
        self.height = height
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        GeometryReader { proxy in
            let w = width ?? proxy.size.width
            ZStack {
                // Base track
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(trackColor)

                if !reduceMotion {
                    // Shimmer gradient slides left-to-right
                    LinearGradient(
                        stops: [
                            .init(color: .clear,        location: 0.0),
                            .init(color: shimmerHighlight, location: 0.35),
                            .init(color: shimmerHighlight, location: 0.65),
                            .init(color: .clear,        location: 1.0)
                        ],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: w)
                    .offset(x: shimmerOffset * w)
                    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                }
            }
            .frame(width: w, height: height)
        }
        .frame(width: width, height: height)
        .onAppear { startShimmer() }
        .onChange(of: reduceMotion) { _, nowReduced in
            if nowReduced {
                shimmerOffset = 0
            } else {
                startShimmer()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading")
        .accessibilityAddTraits(.isStaticText)
    }

    // MARK: - Shimmer loop

    private func startShimmer() {
        guard !reduceMotion else { return }
        shimmerOffset = -1.0
        withAnimation(
            .linear(duration: 1.4).repeatForever(autoreverses: false)
        ) {
            shimmerOffset = 1.0
        }
    }

    // MARK: - Colors

    private var trackColor: Color {
        theme.scheme == .dark
            ? OrpheusColor.Border.subtle.darkColor
            : OrpheusColor.Border.subtle.lightColor
    }

    private var shimmerHighlight: Color {
        // Border.default at a low opacity acts as the translucent highlight
        let base = theme.scheme == .dark
            ? OrpheusColor.Border.default.darkColor
            : OrpheusColor.Border.default.lightColor
        return base.opacity(0.55)
    }
}

// MARK: - Convenience multi-line layout

public extension OrpheusSkeleton {
    /// Three-bar loading-text shape matching the W19 skeleton pattern.
    /// Line widths decrease at 100%, 80%, 60% so the block reads as text.
    static func row(lines: Int = 3) -> some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
            ForEach(0..<lines, id: \.self) { index in
                GeometryReader { proxy in
                    let fraction: CGFloat = switch index % 3 {
                    case 0: 1.00
                    case 1: 0.80
                    default: 0.60
                    }
                    OrpheusSkeleton(width: proxy.size.width * fraction)
                }
                .frame(height: 12)
            }
        }
    }
}

// MARK: - Previews

#Preview("Skeleton · dark") {
    skeletonPreview().orpheusTheme(.dark)
}

#Preview("Skeleton · light") {
    skeletonPreview().orpheusTheme(.light)
}

@MainActor
private func skeletonPreview() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
        OrpheusText("Single bars", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)

        OrpheusSkeleton(width: 240, height: 12)
        OrpheusSkeleton(width: 180, height: 20)
        OrpheusSkeleton(width: 120, height: 8)
        OrpheusSkeleton(height: 32, cornerRadius: OrpheusRadius.card)   // full-width

        Spacer().frame(height: OrpheusSpacing.xs)
        OrpheusText("Multi-line row (W19 shape)", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)

        OrpheusSkeleton.row(lines: 3)
            .frame(width: 280)

        Spacer().frame(height: OrpheusSpacing.xs)
        OrpheusText("Two-column skeleton (W19 shape)", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)

        HStack(alignment: .top, spacing: OrpheusSpacing.md) {
            OrpheusSkeleton.row(lines: 3).frame(width: 160)
            OrpheusSkeleton.row(lines: 3).frame(width: 160)
        }
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 400, alignment: .leading)
    .orpheusBackground(OrpheusColor.Surface.base)
}
