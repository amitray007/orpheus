import SwiftUI
import OrpheusDesign

/// Reusable sidebar section header row.
struct SidebarSection: View {
    let title: String

    var body: some View {
        OrpheusText(
            "-- \(title) --",
            style: OrpheusTypography.caption,
            color: OrpheusColor.Text.disabled
        )
        .padding(.horizontal, OrpheusSpacing.sm)
        .padding(.top, OrpheusSpacing.xs)
        .padding(.bottom, OrpheusSpacing.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
