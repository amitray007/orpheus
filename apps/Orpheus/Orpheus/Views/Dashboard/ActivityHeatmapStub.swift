import SwiftUI
import OrpheusDesign

/// Static placeholder heatmap matching the W2 wireframe shape.
/// Renders a 5×7 grid of intensity cells for Claude Code and GitHub.
/// Phase 4 replaces this with real activity data.
struct ActivityHeatmapStub: View {
    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
            OrpheusText("Activity (last 30 days)",
                        style: OrpheusTypography.heading,
                        color: OrpheusColor.Text.primary)

            HStack(alignment: .top, spacing: OrpheusSpacing.xl) {
                heatmapGrid(label: "Claude Code", cells: claudeCodeCells)
                heatmapGrid(label: "GitHub", cells: githubCells)
                Spacer()
            }
        }
    }

    private func heatmapGrid(label: String, cells: [[HeatmapIntensity]]) -> some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.xxs) {
            OrpheusText(label,
                        style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.secondary)

            Canvas { context, _ in
                let cellSize: CGFloat = 10
                let gap: CGFloat = 2
                for (row, rowCells) in cells.enumerated() {
                    for (col, intensity) in rowCells.enumerated() {
                        let x = CGFloat(col) * (cellSize + gap)
                        let y = CGFloat(row) * (cellSize + gap)
                        let rect = CGRect(x: x, y: y, width: cellSize, height: cellSize)
                        let path = Path(roundedRect: rect,
                                        cornerRadius: OrpheusRadius.chip,
                                        style: .continuous)
                        context.fill(path, with: .color(intensity.color))
                    }
                }
            }
            .frame(
                width: CGFloat(cells[0].count) * 12,
                height: CGFloat(cells.count) * 12
            )
        }
    }

    // MARK: - Static placeholder data (W2 wireframe shape)

    private enum HeatmapIntensity {
        case empty, light, medium, heavy

        var color: Color {
            // Use OrpheusColor tokens resolved statically for Canvas rendering
            switch self {
            case .empty:  return OrpheusColor.Border.subtle.resolved.opacity(0.4)
            case .light:  return OrpheusColor.Accent.subtle.resolved
            case .medium: return OrpheusColor.Accent.primary.resolved.opacity(0.5)
            case .heavy:  return OrpheusColor.Accent.primary.resolved
            }
        }
    }

    private let claudeCodeCells: [[HeatmapIntensity]] = [
        [.empty, .empty, .light, .light, .heavy, .heavy, .empty],
        [.light, .heavy, .heavy, .light, .heavy, .empty, .empty],
        [.empty, .light, .empty, .light, .empty, .light, .light],
        [.heavy, .empty, .empty, .light, .empty, .empty, .empty],
        [.empty, .light, .empty, .heavy, .empty, .empty, .empty],
    ]

    private let githubCells: [[HeatmapIntensity]] = [
        [.empty, .empty, .empty, .heavy, .heavy, .empty, .light],
        [.light, .empty, .heavy, .empty, .heavy, .empty, .empty],
        [.empty, .empty, .empty, .empty, .light, .heavy, .empty],
        [.empty, .heavy, .empty, .empty, .empty, .empty, .empty],
        [.empty, .empty, .empty, .empty, .empty, .empty, .empty],
    ]
}
