import SwiftUI
import OrpheusDesign

/// W18: first-run onboarding. Shown only once when the database is fresh.
struct OnboardingView: View {
    @Environment(AppState.self) private var appState

    private var vm: OnboardingViewModel { appState.onboardingViewModel }

    var body: some View {
        VStack(spacing: OrpheusSpacing.xl) {
            Spacer()

            // Title + tagline
            VStack(spacing: OrpheusSpacing.sm) {
                OrpheusText(
                    "Welcome to Orpheus",
                    style: OrpheusTypography.display,
                    color: OrpheusColor.Text.primary,
                    alignment: .center
                )
                OrpheusText(
                    "A Mac IDE built around Claude Code.",
                    style: OrpheusTypography.body,
                    color: OrpheusColor.Text.secondary,
                    alignment: .center
                )
            }

            // 3-step explainer
            VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
                onboardingStep(
                    number: "1",
                    title: "Add a repository",
                    description: "Point Orpheus at any local folder to create your first project."
                )
                onboardingStep(
                    number: "2",
                    title: "Open a space",
                    description: "Each project gets a Default Space where you can start Claude sessions."
                )
                onboardingStep(
                    number: "3",
                    title: "Start chatting",
                    description: "Orpheus hosts Claude Code in a rich session viewer. Sessions auto-save."
                )
            }
            .padding(.horizontal, OrpheusSpacing.xl)
            .frame(maxWidth: 520)

            // CTAs
            HStack(spacing: OrpheusSpacing.sm) {
                OrpheusButton(
                    "Add repository",
                    leadingIcon: OrpheusIcon(systemName: "plus", size: .medium,
                                              color: OrpheusColor.Text.inverted),
                    variant: .primary,
                    size: .large,
                    isLoading: vm.isAdding
                ) {
                    vm.addRepositoryViaFolderPicker()
                }

                OrpheusButton(
                    "Open folder...",
                    variant: .secondary,
                    size: .large
                ) {
                    vm.addRepositoryViaFolderPicker()
                }
            }

            // Keyboard hint
            OrpheusText(
                "Cmd+,  to open Settings",
                style: OrpheusTypography.caption,
                color: OrpheusColor.Text.tertiary,
                alignment: .center
            )

            Spacer()
        }
        .padding(OrpheusSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .orpheusBackground(OrpheusColor.Surface.base)
    }

    private func onboardingStep(number: String, title: String, description: String) -> some View {
        HStack(alignment: .top, spacing: OrpheusSpacing.sm) {
            // Step number badge
            ZStack {
                Circle()
                    .fill(OrpheusColor.Accent.subtle.resolved)
                    .frame(width: 24, height: 24)
                OrpheusText(number,
                            style: OrpheusTypography.caption,
                            color: OrpheusColor.Accent.primary)
            }
            .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: OrpheusSpacing.xxs) {
                OrpheusText(title,
                            style: OrpheusTypography.heading,
                            color: OrpheusColor.Text.primary)
                OrpheusText(description,
                            style: OrpheusTypography.body,
                            color: OrpheusColor.Text.secondary)
            }
        }
    }
}
