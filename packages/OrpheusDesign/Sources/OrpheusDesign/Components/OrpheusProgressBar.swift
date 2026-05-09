import SwiftUI

/// Determinate and indeterminate progress bar.
///
/// Pass `progress: nil` for the indeterminate sliding animation; pass a
/// value in `0…1` for a filled determinate bar that transitions on change.
public struct OrpheusProgressBar: View {

    public enum Size: Sendable, Equatable {
        case small      // 2pt height
        case medium     // 4pt height
        case large      // 6pt height

        var height: CGFloat {
            switch self {
            case .small:  return 2
            case .medium: return 4
            case .large:  return 6
            }
        }
    }

    private let progress: Double?
    private let size: Size
    private let accent: OrpheusThemedColor

    @State private var indeterminateOffset: CGFloat = -0.30
    @Environment(\.orpheusTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        progress: Double? = nil,
        size: Size = .medium,
        accent: OrpheusThemedColor = OrpheusColor.Accent.primary
    ) {
        self.progress = progress
        self.size = size
        self.accent = accent
    }

    public var body: some View {
        GeometryReader { proxy in
            let trackWidth = proxy.size.width
            let barHeight  = size.height

            ZStack(alignment: .leading) {
                // Track
                RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                    .fill(trackColor)
                    .frame(height: barHeight)

                // Filled bar (determinate) or sliding bar (indeterminate)
                if let progress {
                    RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                        .fill(accentColor)
                        .frame(width: max(0, trackWidth * CGFloat(progress.clamped(to: 0...1))),
                               height: barHeight)
                        .animation(OrpheusMotion.standardAnim, value: progress)
                } else {
                    // Indeterminate — 30%-wide bar sliding from off-left to off-right
                    let barWidth = trackWidth * 0.30
                    RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                        .fill(accentColor)
                        .frame(width: barWidth, height: barHeight)
                        .offset(x: indeterminateOffset * trackWidth)
                        .onAppear {
                            guard !reduceMotion else { return }
                            indeterminateOffset = -0.30
                            withAnimation(
                                .linear(duration: 1.6).repeatForever(autoreverses: false)
                            ) {
                                indeterminateOffset = 1.0
                            }
                        }
                        .onChange(of: reduceMotion) { _, nowReduced in
                            if nowReduced {
                                indeterminateOffset = 0.35  // sit near center, no motion
                            } else {
                                indeterminateOffset = -0.30
                                withAnimation(
                                    .linear(duration: 1.6).repeatForever(autoreverses: false)
                                ) {
                                    indeterminateOffset = 1.0
                                }
                            }
                        }
                }
            }
            .frame(height: barHeight)
            .clipped()
        }
        .frame(height: size.height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(progress.map { "Progress: \(Int($0 * 100)) percent" } ?? "Loading")
        .accessibilityValue(progress.map { "\(Int($0 * 100))%" } ?? "")
    }

    private var trackColor: Color {
        theme.scheme == .dark
            ? OrpheusColor.Border.subtle.darkColor
            : OrpheusColor.Border.subtle.lightColor
    }

    private var accentColor: Color {
        theme.scheme == .dark ? accent.darkColor : accent.lightColor
    }
}

// MARK: - Helpers

private extension Double {
    func clamped(to range: ClosedRange<Double>) -> Double {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

// MARK: - Previews

#Preview("Progress bar · dark") {
    progressBarPreview().orpheusTheme(.dark)
}

#Preview("Progress bar · light") {
    progressBarPreview().orpheusTheme(.light)
}

@MainActor
private func progressBarPreview() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
        OrpheusText("Determinate", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)

        labeledBar("0 %")  { OrpheusProgressBar(progress: 0.00) }
        labeledBar("35 %") { OrpheusProgressBar(progress: 0.35) }
        labeledBar("100 %"){ OrpheusProgressBar(progress: 1.00) }

        Spacer().frame(height: OrpheusSpacing.xs)
        OrpheusText("Indeterminate", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)

        labeledBar("—")    { OrpheusProgressBar() }

        Spacer().frame(height: OrpheusSpacing.xs)
        OrpheusText("Sizes", style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)

        labeledBar("small")  { OrpheusProgressBar(progress: 0.6, size: .small) }
        labeledBar("medium") { OrpheusProgressBar(progress: 0.6, size: .medium) }
        labeledBar("large")  { OrpheusProgressBar(progress: 0.6, size: .large) }
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 360, alignment: .leading)
    .orpheusBackground(OrpheusColor.Surface.base)
}

@MainActor
private func labeledBar<V: View>(
    _ label: String,
    @ViewBuilder bar: () -> V
) -> some View {
    HStack(spacing: OrpheusSpacing.sm) {
        OrpheusText(label, style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.secondary)
            .frame(width: 52, alignment: .trailing)
        bar()
    }
}
