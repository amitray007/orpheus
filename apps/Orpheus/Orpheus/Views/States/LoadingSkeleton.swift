import SwiftUI
import OrpheusDesign

/// W19 loading-skeleton pattern. Token-styled shimmer rows signaling "loading".
struct LoadingSkeleton: View {
    let rows: Int
    let hasHeader: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
            if hasHeader {
                OrpheusSkeleton(width: 180, height: 22,
                                cornerRadius: OrpheusRadius.card)
            }
            ForEach(0..<rows, id: \.self) { _ in
                OrpheusSkeleton.row(lines: 2)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}
