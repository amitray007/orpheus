import SwiftUI
import OrpheusDesign
import OrpheusCore

/// W3: empty space session picker. Shown when a space has no active terminals.
/// The picker buttons stub the spawn action; Phase 2C wires them up.
struct EmptySpaceView: View {
    let spaceID: SpaceID
    @Environment(AppState.self) private var appState

    @State private var space: Space?
    @State private var project: Project?
    @State private var recentSessions: [SessionMetadata] = []

    var body: some View {
        VStack(spacing: 0) {
            // Header bar
            headerBar

            Divider()
                .overlay(OrpheusColor.Border.subtle.resolved)

            // Space title row
            spaceTitle

            Divider()
                .overlay(OrpheusColor.Border.subtle.resolved)

            // Session picker body
            ScrollView {
                sessionPickerBody
                    .padding(OrpheusSpacing.lg)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .orpheusBackground(OrpheusColor.Surface.base)
        .task { await loadSpaceData() }
    }

    // MARK: - Sub-views

    private var headerBar: some View {
        HStack {
            OrpheusButton(
                "",
                leadingIcon: OrpheusIcon(systemName: "plus", size: .medium,
                                          color: OrpheusColor.Text.secondary),
                variant: .ghost,
                size: .medium
            ) {
                // Space switcher toggle — Phase 2C
            }

            Spacer()

            OrpheusButton(
                "Terminal",
                leadingIcon: OrpheusIcon(systemName: "plus.minus", size: .small,
                                          color: OrpheusColor.Text.secondary),
                variant: .secondary,
                size: .small
            ) {
                // Spawn plain terminal — Phase 2C
                OrpheusAppLogger.app.info("Phase 2C will spawn a terminal here")
            }
        }
        .padding(.horizontal, OrpheusSpacing.md)
        .padding(.vertical, OrpheusSpacing.xs)
    }

    private var spaceTitle: some View {
        HStack {
            OrpheusText(
                space?.name ?? "Space",
                style: OrpheusTypography.heading,
                color: OrpheusColor.Text.primary
            )
            Spacer()
        }
        .padding(.horizontal, OrpheusSpacing.lg)
        .padding(.vertical, OrpheusSpacing.sm)
    }

    private var sessionPickerBody: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.lg) {
            // Main heading
            OrpheusText(
                "Start a Claude session in this space",
                style: OrpheusTypography.heading,
                color: OrpheusColor.Text.primary
            )

            // New session card
            newSessionCard

            // Resume section
            if !recentSessions.isEmpty {
                OrpheusText(
                    "Or resume a recent session in this project",
                    style: OrpheusTypography.body,
                    color: OrpheusColor.Text.secondary
                )

                resumeCards
            }

            // View all sessions link
            OrpheusButton(
                "View all sessions",
                variant: .ghost,
                size: .small
            ) {
                // Phase 4: sessions browser
                OrpheusAppLogger.app.info("Phase 4 will open the sessions browser")
            }
        }
        .frame(maxWidth: 680)
    }

    private var newSessionCard: some View {
        Button(action: spawnNewSession) { // orpheus-allow:stock-control
            HStack {
                VStack(alignment: .leading, spacing: OrpheusSpacing.xxs) {
                    HStack(spacing: OrpheusSpacing.xs) {
                        OrpheusIcon(systemName: "plus", size: .medium,
                                    color: OrpheusColor.Accent.primary)
                        OrpheusText("New Claude session",
                                    style: OrpheusTypography.heading,
                                    color: OrpheusColor.Text.primary)
                    }
                    OrpheusText(
                        "Fresh context in \(project?.rootPath ?? "~")",
                        style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary
                    )
                }
                Spacer()
                OrpheusText("Cmd+Enter",
                            style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.disabled)
            }
            .padding(OrpheusSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                    .fill(OrpheusColor.Surface.raised.resolved)
            )
            .overlay(
                RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                    .strokeBorder(OrpheusColor.Border.default.resolved, lineWidth: 1)
            )
        }
        .buttonStyle(.plain) // orpheus-allow:stock-control
        .keyboardShortcut(.return, modifiers: .command)
    }

    private var resumeCards: some View {
        VStack(spacing: 0) {
            ForEach(Array(recentSessions.prefix(3).enumerated()), id: \.element.sessionID) { idx, session in
                resumeCard(session, isFirst: idx == 0, isLast: idx == min(2, recentSessions.count - 1))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                .fill(OrpheusColor.Surface.raised.resolved)
        )
        .overlay(
            RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                .strokeBorder(OrpheusColor.Border.default.resolved, lineWidth: 1)
        )
    }

    private func resumeCard(
        _ session: SessionMetadata,
        isFirst: Bool,
        isLast: Bool
    ) -> some View {
        VStack(spacing: 0) {
            if !isFirst {
                Divider()
                    .overlay(OrpheusColor.Border.subtle.resolved)
            }
            HStack(spacing: OrpheusSpacing.sm) {
                OrpheusIcon(systemName: "circle", size: .small,
                             color: OrpheusColor.Text.secondary)

                VStack(alignment: .leading, spacing: 2) {
                    OrpheusText(truncatedTitle(session),
                                style: OrpheusTypography.body,
                                color: OrpheusColor.Text.primary)
                }
                Spacer()

                OrpheusText(relativeTime(session.lastUpdated),
                            style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)

                OrpheusButton("Resume", variant: .secondary, size: .small) {
                    resumeSession(session)
                }
            }
            .padding(.horizontal, OrpheusSpacing.md)
            .padding(.vertical, OrpheusSpacing.sm)
        }
    }

    // MARK: - Actions

    private func spawnNewSession() {
        OrpheusAppLogger.app.info("Phase 2C will spawn a terminal here")
    }

    private func resumeSession(_ session: SessionMetadata) {
        OrpheusAppLogger.app.info(
            "Phase 2C will spawn the terminal here (resume \(session.sessionID.rawValue, privacy: .public))"
        )
    }

    // MARK: - Data loading

    private func loadSpaceData() async {
        do {
            space = try await appState.spaceRepository.fetch(id: spaceID)
            if let projectID = space?.projectID {
                project = try await appState.projectRepository.fetch(id: projectID)
                if let rootPath = project?.rootPath {
                    recentSessions = await appState.sessionRegistry.sessions(forCWD: rootPath)
                }
            }
        } catch {
            OrpheusAppLogger.errors.error(
                "EmptySpaceView load failed: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    // MARK: - Helpers

    private func truncatedTitle(_ session: SessionMetadata) -> String {
        let raw = session.name ?? session.cwd.split(separator: "/").last.map(String.init) ?? "Session"
        return raw.count > 40 ? String(raw.prefix(40)) + "…" : raw
    }

    private func relativeTime(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 3600 { return "\(Int(interval / 60))m" }
        if interval < 86400 { return "\(Int(interval / 3600))h" }
        if interval < 604800 { return "\(Int(interval / 86400))d" }
        return "\(Int(interval / 604800))w"
    }
}
