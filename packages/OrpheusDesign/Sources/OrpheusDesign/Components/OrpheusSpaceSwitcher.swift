import SwiftUI

// MARK: - Data model

public struct ProjectItem: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let isExpanded: Bool
    public let spaces: [SpaceItem]

    public init(id: String, name: String, isExpanded: Bool, spaces: [SpaceItem]) {
        self.id = id
        self.name = name
        self.isExpanded = isExpanded
        self.spaces = spaces
    }
}

public struct SpaceItem: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let activity: Activity
    public let isActive: Bool

    public init(id: String, name: String, activity: Activity, isActive: Bool = false) {
        self.id = id
        self.name = name
        self.activity = activity
        self.isActive = isActive
    }
}

public enum Activity: String, Sendable {
    case running   = "/"   // active streaming
    case idle      = "-"   // idle but attached
    case attention = "*"   // needs user input
    case detached  = "o"   // detached / cold
    case dormant   = "."   // dormant / archived
}

// MARK: - Component

/// Nested project / space list rendered inside `OrpheusSidebar`.
public struct OrpheusSpaceSwitcher: View {

    private let projects: [ProjectItem]
    private let activeSpaceID: String?
    private let onProjectToggle: (ProjectItem.ID) -> Void
    private let onSpaceSelect: (SpaceItem.ID) -> Void
    private let onSpaceContextMenu: ((SpaceItem.ID) -> Void)?

    public init(
        projects: [ProjectItem],
        activeSpaceID: String? = nil,
        onProjectToggle: @escaping (ProjectItem.ID) -> Void = { _ in },
        onSpaceSelect: @escaping (SpaceItem.ID) -> Void = { _ in },
        onSpaceContextMenu: ((SpaceItem.ID) -> Void)? = nil
    ) {
        self.projects = projects
        self.activeSpaceID = activeSpaceID
        self.onProjectToggle = onProjectToggle
        self.onSpaceSelect = onSpaceSelect
        self.onSpaceContextMenu = onSpaceContextMenu
    }

    public var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(projects) { project in
                ProjectRow(
                    project: project,
                    activeSpaceID: activeSpaceID,
                    onProjectToggle: onProjectToggle,
                    onSpaceSelect: onSpaceSelect,
                    onSpaceContextMenu: onSpaceContextMenu
                )
            }
        }
    }
}

// MARK: - Project row

private struct ProjectRow: View {
    let project: ProjectItem
    let activeSpaceID: String?
    let onProjectToggle: (ProjectItem.ID) -> Void
    let onSpaceSelect: (SpaceItem.ID) -> Void
    let onSpaceContextMenu: ((SpaceItem.ID) -> Void)?

    @State private var isHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Project header row — 28pt height
            HStack(spacing: OrpheusSpacing.xxs) {
                Group {
                    if project.isExpanded {
                        OrpheusIconSlot.chevronOpen()
                    } else {
                        OrpheusIconSlot.chevronClosed()
                    }
                }
                .frame(width: 14)

                OrpheusIconSlot.project(size: .small, color: OrpheusColor.Text.secondary)

                Text(project.name)
                    .orpheusFont(OrpheusTypography.body)
                    .orpheusForeground(OrpheusColor.Text.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, OrpheusSpacing.sm)
            .frame(height: 28)
            .background(
                isHovered
                    ? OrpheusColor.Surface.elevated.resolved
                    : Color.clear
            )
            .contentShape(Rectangle())
            .onTapGesture { onProjectToggle(project.id) }
            .onHover { hovering in
                withAnimation(OrpheusMotion.quickAnim) { isHovered = hovering }
            }
            .accessibilityLabel(project.name)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(project.isExpanded ? "expanded" : "collapsed")

            // Nested spaces — only rendered when expanded
            if project.isExpanded {
                ForEach(project.spaces) { space in
                    SpaceRow(
                        space: space,
                        isActive: space.id == activeSpaceID || space.isActive,
                        onSelect: { onSpaceSelect(space.id) },
                        onContextMenu: onSpaceContextMenu.map { handler in
                            { handler(space.id) }
                        }
                    )
                }
            }
        }
        .animation(OrpheusMotion.standardAnim, value: project.isExpanded)
    }
}

// MARK: - Space row

private struct SpaceRow: View {
    let space: SpaceItem
    let isActive: Bool
    let onSelect: () -> Void
    let onContextMenu: (() -> Void)?

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: OrpheusSpacing.xxs) {
            // Indentation from the leading edge
            Spacer()
                .frame(width: OrpheusSpacing.lg)

            OrpheusIconSlot.space(size: .small, color: OrpheusColor.Text.tertiary)

            // Activity glyph — mono caption
            Text(space.activity.rawValue)
                .orpheusFont(OrpheusTypography.mono)
                .font(OrpheusTypography.mono.font.monospacedDigit())
                .orpheusForeground(activityColor(for: space.activity))
                .frame(width: 10, alignment: .center)
                .accessibilityHidden(true)

            Text(space.name)
                .orpheusFont(isActive ? OrpheusTypography.heading : OrpheusTypography.body)
                .orpheusForeground(isActive ? OrpheusColor.Text.primary : OrpheusColor.Text.secondary)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 0)
        }
        .frame(height: 24)
        .background(
            RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                .fill(
                    isActive
                        ? OrpheusColor.Accent.subtle.resolved
                        : isHovered
                            ? OrpheusColor.Surface.elevated.resolved
                            : Color.clear
                )
                .padding(.horizontal, OrpheusSpacing.xxs)
        )
        .contentShape(Rectangle())
        .onTapGesture { onSelect() }
        .onHover { hovering in
            withAnimation(OrpheusMotion.quickAnim) { isHovered = hovering }
        }
        .accessibilityLabel(space.name)
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
        .accessibilityValue(space.activity.accessibilityDescription)
    }

    private func activityColor(for activity: Activity) -> OrpheusThemedColor {
        switch activity {
        case .running:   return OrpheusColor.Semantic.success
        case .attention: return OrpheusColor.Semantic.warning
        case .idle:      return OrpheusColor.Text.tertiary
        case .detached:  return OrpheusColor.Text.tertiary
        case .dormant:   return OrpheusColor.Text.disabled
        }
    }
}

// MARK: - Accessibility helpers

private extension Activity {
    var accessibilityDescription: String {
        switch self {
        case .running:   return "streaming"
        case .idle:      return "idle"
        case .attention: return "needs attention"
        case .detached:  return "detached"
        case .dormant:   return "dormant"
        }
    }
}

// MARK: - Previews

#Preview("Space switcher · dark") {
    spaceSwitcherPreview()
        .orpheusTheme(.dark)
}

#Preview("Space switcher · light") {
    spaceSwitcherPreview()
        .orpheusTheme(.light)
}

@MainActor
private func spaceSwitcherPreview() -> some View {
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

    return ScrollView {
        OrpheusSpaceSwitcher(
            projects: projects,
            activeSpaceID: "myspace"
        )
    }
    .frame(width: 240, height: 400)
    .orpheusBackground(OrpheusColor.Surface.raised)
}
