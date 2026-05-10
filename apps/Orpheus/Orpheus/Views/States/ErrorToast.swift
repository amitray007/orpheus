import SwiftUI
import OrpheusDesign

/// W19 error-toast pattern. Transient top-right notification.
/// 6s auto-dismiss; explicit close button.
struct ErrorToast: View {
    let message: String
    let kind: OrpheusToast.Kind
    var title: String? = nil
    var onDismiss: (() -> Void)? = nil

    @State private var dismissTimer: Task<Void, Never>?

    var body: some View {
        OrpheusToast(
            message,
            kind: kind,
            title: title,
            onDismiss: {
                dismissTimer?.cancel()
                onDismiss?()
            }
        )
        .onAppear {
            dismissTimer = Task {
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                guard !Task.isCancelled else { return }
                await MainActor.run { onDismiss?() }
            }
        }
        .onDisappear {
            dismissTimer?.cancel()
        }
    }
}
