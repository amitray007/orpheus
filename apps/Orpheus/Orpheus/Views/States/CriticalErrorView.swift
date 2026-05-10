import SwiftUI
import OrpheusDesign

/// Shown when `Database` open fails on launch. Uses W19 patterns.
/// Provides a path to open support or reset app data.
struct CriticalErrorView: View {
    let message: String

    @State private var showResetConfirmation = false

    var body: some View {
        VStack(spacing: OrpheusSpacing.lg) {
            Spacer()

            OrpheusIconSlot.critical(size: .xlarge, color: OrpheusColor.Semantic.critical)

            VStack(spacing: OrpheusSpacing.sm) {
                OrpheusText(
                    "Unable to open Orpheus",
                    style: OrpheusTypography.title,
                    color: OrpheusColor.Text.primary,
                    alignment: .center
                )
                OrpheusText(
                    "The database could not be opened.",
                    style: OrpheusTypography.body,
                    color: OrpheusColor.Text.secondary,
                    alignment: .center
                )
            }

            ErrorBanner(
                message: message,
                kind: .critical,
                title: "Technical details"
            )
            .frame(maxWidth: 480)

            HStack(spacing: OrpheusSpacing.sm) {
                OrpheusButton("Open support", variant: .secondary, size: .medium) {
                    let mailto = URL(string: "mailto:support@orpheus.app")!
                    NSWorkspace.shared.open(mailto)
                }

                OrpheusButton("Reset app data", variant: .destructive, size: .medium) {
                    showResetConfirmation = true
                }
            }

            Spacer()
        }
        .padding(OrpheusSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .orpheusBackground(OrpheusColor.Surface.base)
        .alert("Reset App Data?", isPresented: $showResetConfirmation) { // orpheus-allow:stock-control
            Button("Reset", role: .destructive) { resetAppData() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will delete all Orpheus data. Your project files on disk are not affected.")
        }
    }

    private func resetAppData() {
        let dbPath = DBLocator.resolve()
        try? FileManager.default.removeItem(atPath: dbPath)
        NSApp.terminate(nil)
    }
}
