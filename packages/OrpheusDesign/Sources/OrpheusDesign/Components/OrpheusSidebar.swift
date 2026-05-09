import SwiftUI

/// Full-height left panel composing three vertical slots: top (search /
/// project picker), body (scrollable space switcher or any list), and
/// bottom (settings / account / status bar).
///
/// The three slots are generic so any view composes in — in the app shell
/// the body will typically be `OrpheusSpaceSwitcher`.
public struct OrpheusSidebar<Top: View, Body: View, Bottom: View>: View {

    private let width: CGFloat
    private let top: Top
    private let bodyContent: Body
    private let bottom: Bottom

    public init(
        width: CGFloat = 240,
        @ViewBuilder top: () -> Top,
        @ViewBuilder bodyContent: () -> Body,
        @ViewBuilder bottom: () -> Bottom
    ) {
        self.width = width
        self.top = top()
        self.bodyContent = bodyContent()
        self.bottom = bottom()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top slot
            top
                .padding(OrpheusSpacing.sm)

            // Top separator
            Divider()
                .overlay(OrpheusColor.Border.subtle.resolved)
                .frame(height: 1)

            // Body slot — scrollable, fills remaining space
            ScrollView(.vertical, showsIndicators: false) {
                bodyContent
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Bottom separator
            Divider()
                .overlay(OrpheusColor.Border.subtle.resolved)
                .frame(height: 1)

            // Bottom slot
            bottom
                .padding(OrpheusSpacing.xs)
        }
        .frame(width: width)
        .frame(minHeight: 400, idealHeight: 600)
        .orpheusMaterial(OrpheusMaterial.sidebar)
    }
}

// MARK: - Previews

#Preview("Sidebar · dark") {
    sidebarPreview()
        .orpheusTheme(.dark)
}

#Preview("Sidebar · light") {
    sidebarPreview()
        .orpheusTheme(.light)
}

@MainActor
private func sidebarPreview() -> some View {
    let projects: [ProjectItem] = [
        ProjectItem(
            id: "thoughts",
            name: "thoughts",
            isExpanded: true,
            spaces: [
                SpaceItem(id: "myspace",   name: "My Space",         activity: .running,   isActive: true),
                SpaceItem(id: "brains",    name: "brainstorm-ide",   activity: .dormant,   isActive: false),
                SpaceItem(id: "migrate",   name: "migrate-valorant", activity: .detached,  isActive: false),
            ]
        ),
        ProjectItem(
            id: "scaleup",
            name: "scaleup-studio",
            isExpanded: true,
            spaces: [
                SpaceItem(id: "su-auth",   name: "auth-rewrite",     activity: .attention, isActive: false),
                SpaceItem(id: "su-harbor", name: "phase-1-harbor",   activity: .idle,      isActive: false),
            ]
        ),
        ProjectItem(
            id: "pare",
            name: "pare",
            isExpanded: false,
            spaces: [
                SpaceItem(id: "pare-main", name: "main",             activity: .dormant,   isActive: false),
            ]
        ),
    ]

    return OrpheusSidebar(
        top: {
            // Search field placeholder row
            HStack(spacing: OrpheusSpacing.xs) {
                OrpheusIconSlot.search(size: .small, color: OrpheusColor.Text.tertiary)
                Text("Search")
                    .orpheusFont(OrpheusTypography.body)
                    .orpheusForeground(OrpheusColor.Text.disabled)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, OrpheusSpacing.xs)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous)
                    .fill(OrpheusColor.Surface.elevated.resolved)
            )
            .orpheusBorder(OrpheusColor.Border.subtle,
                           width: 1,
                           cornerRadius: OrpheusRadius.button)
        },
        bodyContent: {
            // Section header
            HStack {
                Text("Projects")
                    .orpheusFont(OrpheusTypography.caption)
                    .orpheusForeground(OrpheusColor.Text.tertiary)
                    .padding(.horizontal, OrpheusSpacing.sm)
                    .padding(.top, OrpheusSpacing.xs)
                Spacer(minLength: 0)
            }

            OrpheusSpaceSwitcher(
                projects: projects,
                activeSpaceID: "myspace"
            )
        },
        bottom: {
            // Status row
            HStack(spacing: OrpheusSpacing.xs) {
                OrpheusIconSlot.selfDrive(size: .small, color: OrpheusColor.Text.tertiary)

                Text("Orpheus")
                    .orpheusFont(OrpheusTypography.caption)
                    .orpheusForeground(OrpheusColor.Text.tertiary)

                Spacer(minLength: 0)

                Text("42k / $0.34")
                    .orpheusFont(OrpheusTypography.caption)
                    .orpheusForeground(OrpheusColor.Text.disabled)
            }
            .padding(.horizontal, OrpheusSpacing.xs)
            .frame(height: 24)
            .accessibilityLabel("Status: 42k tokens, $0.34 today")
        }
    )
    // Wrap in a surface so the glass material has something to blur behind it
    .background(OrpheusColor.Surface.base.resolved)
    .frame(height: 520)
}
