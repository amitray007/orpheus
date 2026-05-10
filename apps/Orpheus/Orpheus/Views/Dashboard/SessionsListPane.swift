import SwiftUI
import OrpheusDesign
import OrpheusCore

/// W2 right split: cross-project recent sessions list.
struct SessionsListPane: View {
    @Environment(AppState.self) private var appState

    private var vm: DashboardViewModel { appState.dashboardViewModel }

    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
            OrpheusText("Sessions (all)",
                        style: OrpheusTypography.heading,
                        color: OrpheusColor.Text.primary)

            if vm.recentSessions.isEmpty {
                EmptyState(
                    title: "No sessions yet",
                    message: "Start a Claude session to see it here.",
                    ctaLabel: nil,
                    ctaAction: nil
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(vm.recentSessions, id: \.sessionID) { session in
                            sessionRow(session)
                            Divider()
                                .overlay(OrpheusColor.Border.subtle.resolved)
                        }
                    }
                }
            }
        }
    }

    private func sessionRow(_ session: SessionMetadata) -> some View {
        OrpheusRow(
            truncatedTitle(session),
            subtitle: nil,
            leading: OrpheusIcon(systemName: "circle.fill", size: .small,
                                  color: OrpheusColor.Text.secondary),
            trailing: AnyView(
                OrpheusText(relativeTime(session.lastUpdated),
                            style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
            ),
            isSelected: false,
            onTap: {
                // Phase 2C: resume session via claude --resume
                OrpheusAppLogger.dashboard.info(
                    "Phase 2C will resume session: \(session.sessionID.rawValue, privacy: .public)"
                )
            }
        )
    }

    private func truncatedTitle(_ session: SessionMetadata) -> String {
        let raw = session.name ?? session.cwd.split(separator: "/").last.map(String.init) ?? "Session"
        return raw.count > 30 ? String(raw.prefix(30)) + "…" : raw
    }

    private func relativeTime(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 3600 { return "\(Int(interval / 60))m" }
        if interval < 86400 { return "\(Int(interval / 3600))h" }
        if interval < 604800 { return "\(Int(interval / 86400))d" }
        return "\(Int(interval / 604800))w"
    }
}
