import SwiftUI
import OrpheusDesign

/// W19 empty-state pattern. Generic centered message with optional CTA.
/// Used by sessions list, projects list, and any future consumer.
struct EmptyState: View {
    let title: String
    let message: String
    let ctaLabel: String?
    let ctaAction: (() -> Void)?

    var body: some View {
        VStack(spacing: OrpheusSpacing.md) {
            OrpheusText(
                title,
                style: OrpheusTypography.heading,
                color: OrpheusColor.Text.secondary,
                alignment: .center
            )
            OrpheusText(
                message,
                style: OrpheusTypography.body,
                color: OrpheusColor.Text.tertiary,
                alignment: .center
            )
            if let ctaLabel, let ctaAction {
                OrpheusButton(ctaLabel, variant: .secondary, size: .small, action: ctaAction)
            }
        }
        .padding(OrpheusSpacing.lg)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}
