import SwiftUI
import OrpheusDesign

/// W19 error-banner pattern. Persistent top-of-surface banner.
/// Uses `OrpheusBanner` with manual dismiss only.
struct ErrorBanner: View {
    let message: String
    let kind: OrpheusBanner.Kind
    var title: String? = nil
    var primaryActionLabel: String? = nil
    var primaryAction: (@Sendable () -> Void)? = nil
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        OrpheusBanner(
            message,
            kind: kind,
            title: title,
            isDismissable: onDismiss != nil,
            primaryAction: primaryActionLabel.map { label in
                OrpheusBanner.Action(title: label, handler: primaryAction ?? {})
            },
            onDismiss: onDismiss
        )
    }
}
