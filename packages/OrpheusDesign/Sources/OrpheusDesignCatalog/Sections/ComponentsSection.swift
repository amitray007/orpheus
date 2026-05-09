import SwiftUI
import OrpheusDesign

// MARK: - All component sections

struct ComponentsSection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.lg) {
            OrpheusTextSection()
            OrpheusButtonSection()
            OrpheusToggleSection()
            OrpheusTextFieldSection()
            OrpheusTextAreaSection()
            OrpheusMenuSection()
            OrpheusListSection()
            OrpheusSplitViewSection()
            OrpheusSidebarSection()
            OrpheusSpaceSwitcherSection()
            OrpheusCommandPaletteSection()
            OrpheusModalSection()
            OrpheusSheetSection()
            OrpheusStatusBadgeSection()
            OrpheusTooltipSection()
            OrpheusQuickActionSection()
            OrpheusSpinnerSection()
            OrpheusProgressBarSection()
            OrpheusSkeletonSection()
            OrpheusToastSection()
            OrpheusBannerSection()
        }
    }
}

// MARK: - 1. OrpheusText

struct OrpheusTextSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusText", subtitle: "Token-bound text view — full type ramp") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                OrpheusText("Display — hero",           style: OrpheusTypography.display)
                OrpheusText("Title — section",          style: OrpheusTypography.title)
                OrpheusText("Heading — subsection",     style: OrpheusTypography.heading)
                OrpheusText("Body — default UI text",   style: OrpheusTypography.body,
                            color: OrpheusColor.Text.secondary)
                OrpheusText("Caption — metadata",       style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusText("mono — terminal · code",   style: OrpheusTypography.mono)
            }
        }
    }
}

// MARK: - 2. OrpheusButton

struct OrpheusButtonSection: View {
    private let variants: [(String, OrpheusButton.Variant)] = [
        ("primary",     .primary),
        ("secondary",   .secondary),
        ("tertiary",    .tertiary),
        ("destructive", .destructive),
        ("ghost",       .ghost),
    ]

    var body: some View {
        CatalogSection(title: "OrpheusButton", subtitle: "Variant × size × state matrix") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                ForEach(variants, id: \.0) { name, variant in
                    HStack(spacing: OrpheusSpacing.sm) {
                        OrpheusText(name,
                                    style: OrpheusTypography.caption,
                                    color: OrpheusColor.Text.tertiary)
                            .frame(width: 88, alignment: .leading)
                        OrpheusButton("Small",    variant: variant, size: .small)  { }
                        OrpheusButton("Medium",   variant: variant, size: .medium) { }
                        OrpheusButton("Large",    variant: variant, size: .large)  { }
                        OrpheusButton("Loading…", variant: variant, isLoading: true) { }
                        OrpheusButton("Off",      variant: variant, isEnabled: false) { }
                    }
                }
            }
        }
    }
}

// MARK: - 3. OrpheusToggle

struct OrpheusToggleSection: View {
    @State private var cbOff  = false
    @State private var cbOn   = true
    @State private var radOff = false
    @State private var radOn  = true
    @State private var swOff  = false
    @State private var swOn   = true

    var body: some View {
        CatalogSection(title: "OrpheusToggle", subtitle: "checkbox · radio · switch × on/off") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
                styleRow("checkbox") {
                    OrpheusToggle(.checkbox, isOn: $cbOff)
                    OrpheusToggle(.checkbox, isOn: $cbOn)
                    OrpheusToggle(.checkbox, isOn: .constant(false), label: "Off label")
                    OrpheusToggle(.checkbox, isOn: .constant(true),  label: "On label")
                    OrpheusToggle(.checkbox, isOn: .constant(true),  isEnabled: false, label: "Disabled")
                }
                styleRow("radio") {
                    OrpheusToggle(.radio, isOn: $radOff)
                    OrpheusToggle(.radio, isOn: $radOn)
                    OrpheusToggle(.radio, isOn: .constant(false), label: "Off label")
                    OrpheusToggle(.radio, isOn: .constant(true),  label: "On label")
                    OrpheusToggle(.radio, isOn: .constant(true),  isEnabled: false, label: "Disabled")
                }
                styleRow("switch") {
                    OrpheusToggle(.switch, isOn: $swOff)
                    OrpheusToggle(.switch, isOn: $swOn)
                    OrpheusToggle(.switch, isOn: .constant(false), label: "Off label")
                    OrpheusToggle(.switch, isOn: .constant(true),  label: "On label")
                    OrpheusToggle(.switch, isOn: .constant(true),  isEnabled: false, label: "Disabled")
                }
            }
        }
    }

    @ViewBuilder
    private func styleRow<C: View>(_ label: String, @ViewBuilder content: () -> C) -> some View {
        HStack(alignment: .center, spacing: OrpheusSpacing.lg) {
            OrpheusText(label,
                        style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.tertiary)
                .frame(width: 60, alignment: .leading)
            content()
        }
    }
}

// MARK: - 4. OrpheusTextField

struct OrpheusTextFieldSection: View {
    @State private var text1 = ""
    @State private var text2 = "Some input value"
    @State private var text3 = ""
    @State private var text4 = "secret"

    var body: some View {
        CatalogSection(title: "OrpheusTextField", subtitle: "empty · filled · icon · disabled") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                OrpheusText("Empty / placeholder", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextField("Placeholder text…", text: $text1)
                    .frame(maxWidth: 360)

                OrpheusText("With value", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextField("Placeholder", text: $text2)
                    .frame(maxWidth: 360)

                OrpheusText("With leading icon", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextField("Search…", text: $text3,
                                 leadingIcon: OrpheusIconSlot.search())
                    .frame(maxWidth: 360)

                OrpheusText("Secure", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextField("Password", text: $text4, isSecure: true)
                    .frame(maxWidth: 360)

                OrpheusText("Disabled", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextField("Disabled field", text: .constant(""), isEnabled: false)
                    .frame(maxWidth: 360)
            }
        }
    }
}

// MARK: - 5. OrpheusTextArea

struct OrpheusTextAreaSection: View {
    @State private var text1 = ""
    @State private var text2 = "Line one\nLine two\nLine three — the area has grown to fit."

    var body: some View {
        CatalogSection(title: "OrpheusTextArea", subtitle: "empty · filled · auto-height") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                OrpheusText("Empty / placeholder", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextArea("Write something…", text: $text1)
                    .frame(maxWidth: 400)

                OrpheusText("With content", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextArea("Write something…", text: $text2)
                    .frame(maxWidth: 400)

                OrpheusText("Disabled", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusTextArea("Disabled area",
                                text: .constant("Can't touch this."),
                                isEnabled: false)
                    .frame(maxWidth: 400)
            }
        }
    }
}

// MARK: - 6. OrpheusMenu

struct OrpheusMenuSection: View {
    private let items: [OrpheusMenu<OrpheusButton>.Item] = [
        .init(title: "Options",         kind: .header("Options")),
        .init(title: "New File",
              icon:  OrpheusIconSlot.project(size: .small),
              kind: .action({ })),
        .init(title: "Open Terminal",
              icon:  OrpheusIconSlot.terminal(size: .small),
              kind: .action({ })),
        .init(title: "---",             kind: .separator),
        .init(title: "Actions",         kind: .header("Actions")),
        .init(title: "Fork Pane",
              icon:  OrpheusIconSlot.fork(size: .small),
              kind: .action({ })),
        .init(title: "Disabled Action",
              kind: .action({ }),
              isEnabled: false),
        .init(title: "---",             kind: .separator),
        .init(title: "Search",
              icon:  OrpheusIconSlot.search(size: .small),
              kind: .action({ })),
    ]

    var body: some View {
        CatalogSection(title: "OrpheusMenu",
                       subtitle: "Custom popover — tap trigger to open") {
            OrpheusMenu(items: items) {
                OrpheusButton("Open menu", variant: .secondary) { }
            }
        }
    }
}

// MARK: - 7. OrpheusList + OrpheusRow

private struct ListSampleItem: Identifiable {
    let id: Int
    let title: String
    let subtitle: String?
    let icon: OrpheusIcon?
}

private let listSamples: [ListSampleItem] = [
    ListSampleItem(id: 0, title: "Identify CPU perf opt", subtitle: "thoughts / My Space",
                   icon: OrpheusIcon(systemName: "star.fill", size: .small, color: OrpheusColor.Accent.primary)),
    ListSampleItem(id: 1, title: "brainstorm-ide-reframe", subtitle: "thoughts / brainstorm", icon: nil),
    ListSampleItem(id: 2, title: "migrate-valorant", subtitle: "thoughts / migrate",
                   icon: OrpheusIconSlot.fork(size: .small)),
    ListSampleItem(id: 3, title: "phase-1-harbor-impl", subtitle: "harbor / phase-1", icon: nil),
    ListSampleItem(id: 4, title: "valorant-catalog", subtitle: "radiant / catalog",
                   icon: OrpheusIconSlot.project(size: .small)),
]

struct OrpheusListSection: View {
    @State private var selection: Int? = 0

    var body: some View {
        CatalogSection(title: "OrpheusList + OrpheusRow", subtitle: "inset · plain · sidebar") {
            HStack(alignment: .top, spacing: OrpheusSpacing.md) {
                // Sidebar style
                VStack(alignment: .leading, spacing: 0) {
                    OrpheusText("sidebar", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                        .padding(.horizontal, OrpheusSpacing.sm)
                        .padding(.vertical, OrpheusSpacing.xxs)
                    OrpheusList(listSamples, id: \.id, style: .sidebar, selection: $selection) { item in
                        OrpheusRow(item.title, subtitle: item.subtitle, leading: item.icon,
                                   isSelected: selection == item.id)
                    }
                }
                .frame(width: 200, height: 200)
                .orpheusBackground(OrpheusColor.Surface.raised)
                .orpheusCornerRadius(OrpheusRadius.card)

                // Inset style
                VStack(alignment: .leading, spacing: 0) {
                    OrpheusText("inset", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                        .padding(.horizontal, OrpheusSpacing.sm)
                        .padding(.vertical, OrpheusSpacing.xxs)
                    OrpheusList(listSamples, id: \.id, style: .inset, selection: $selection) { item in
                        OrpheusRow(item.title, subtitle: item.subtitle,
                                   isSelected: selection == item.id)
                    }
                }
                .frame(width: 220, height: 200)
                .orpheusBackground(OrpheusColor.Surface.base)
                .orpheusCornerRadius(OrpheusRadius.card)

                // Plain style
                VStack(alignment: .leading, spacing: 0) {
                    OrpheusText("plain", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                        .padding(.horizontal, OrpheusSpacing.sm)
                        .padding(.vertical, OrpheusSpacing.xxs)
                    OrpheusList(listSamples, id: \.id, style: .plain, selection: $selection) { item in
                        OrpheusRow(item.title, subtitle: item.subtitle,
                                   isSelected: selection == item.id)
                    }
                }
                .frame(width: 220, height: 200)
                .orpheusBackground(OrpheusColor.Surface.base)
                .orpheusCornerRadius(OrpheusRadius.card)
            }
        }
    }
}

// MARK: - 8. OrpheusSplitView

struct OrpheusSplitViewSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusSplitView", subtitle: "horizontal · vertical, draggable divider") {
            VStack(spacing: OrpheusSpacing.sm) {
                // Horizontal
                OrpheusSplitView(
                    axis: .horizontal,
                    initialFraction: 0.35,
                    minLeadingSize: 120,
                    minTrailingSize: 160,
                    isLeadingCollapsible: true,
                    leading: {
                        VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
                            OrpheusText("Sidebar", style: OrpheusTypography.heading,
                                        color: OrpheusColor.Text.primary)
                            OrpheusText("Sessions · projects", style: OrpheusTypography.caption,
                                        color: OrpheusColor.Text.tertiary)
                            Spacer()
                        }
                        .padding(OrpheusSpacing.sm)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .orpheusBackground(OrpheusColor.Surface.raised)
                    },
                    trailing: {
                        VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
                            OrpheusText("Content", style: OrpheusTypography.heading,
                                        color: OrpheusColor.Text.primary)
                            OrpheusText("Chat viewer or detail pane", style: OrpheusTypography.body,
                                        color: OrpheusColor.Text.secondary)
                            Spacer()
                        }
                        .padding(OrpheusSpacing.sm)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .orpheusBackground(OrpheusColor.Surface.base)
                    }
                )
                .frame(height: 180)
                .orpheusCornerRadius(OrpheusRadius.card)

                // Vertical
                OrpheusSplitView(
                    axis: .vertical,
                    initialFraction: 0.5,
                    minLeadingSize: 60,
                    minTrailingSize: 60,
                    leading: {
                        VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
                            OrpheusText("Top pane", style: OrpheusTypography.heading,
                                        color: OrpheusColor.Text.primary)
                            OrpheusText("Terminal or session list", style: OrpheusTypography.caption,
                                        color: OrpheusColor.Text.tertiary)
                            Spacer()
                        }
                        .padding(OrpheusSpacing.sm)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .orpheusBackground(OrpheusColor.Surface.base)
                    },
                    trailing: {
                        VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
                            OrpheusText("Bottom pane", style: OrpheusTypography.heading,
                                        color: OrpheusColor.Text.primary)
                            OrpheusText("Chat preview or detail", style: OrpheusTypography.body,
                                        color: OrpheusColor.Text.secondary)
                            Spacer()
                        }
                        .padding(OrpheusSpacing.sm)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .orpheusBackground(OrpheusColor.Surface.raised)
                    }
                )
                .frame(height: 180)
                .orpheusCornerRadius(OrpheusRadius.card)
            }
        }
    }
}

// MARK: - 9. OrpheusSidebar

struct OrpheusSidebarSection: View {
    private let projects: [ProjectItem] = [
        ProjectItem(
            id: "thoughts", name: "thoughts", isExpanded: true,
            spaces: [
                SpaceItem(id: "myspace", name: "My Space",         activity: .running,   isActive: true),
                SpaceItem(id: "brains",  name: "brainstorm-ide",   activity: .dormant,   isActive: false),
                SpaceItem(id: "migrate", name: "migrate-valorant", activity: .detached,  isActive: false),
            ]
        ),
        ProjectItem(
            id: "scaleup", name: "scaleup-studio", isExpanded: true,
            spaces: [
                SpaceItem(id: "su-auth",   name: "auth-rewrite",   activity: .attention, isActive: false),
                SpaceItem(id: "su-harbor", name: "phase-1-harbor", activity: .idle,      isActive: false),
            ]
        ),
        ProjectItem(
            id: "pare", name: "pare", isExpanded: false,
            spaces: [
                SpaceItem(id: "pare-main", name: "main",           activity: .dormant,   isActive: false),
            ]
        ),
    ]

    var body: some View {
        CatalogSection(title: "OrpheusSidebar", subtitle: "search · space switcher · status row") {
            OrpheusSidebar(
                width: 240,
                top: {
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
                    HStack {
                        Text("Projects")
                            .orpheusFont(OrpheusTypography.caption)
                            .orpheusForeground(OrpheusColor.Text.tertiary)
                            .padding(.horizontal, OrpheusSpacing.sm)
                            .padding(.top, OrpheusSpacing.xs)
                        Spacer(minLength: 0)
                    }
                    OrpheusSpaceSwitcher(projects: projects, activeSpaceID: "myspace")
                },
                bottom: {
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
            .background(OrpheusColor.Surface.base.resolved)
            .frame(height: 360)
        }
    }
}

// MARK: - 10. OrpheusSpaceSwitcher

struct OrpheusSpaceSwitcherSection: View {
    private let projects: [ProjectItem] = [
        ProjectItem(
            id: "orpheus", name: "orpheus", isExpanded: true,
            spaces: [
                SpaceItem(id: "main",    name: "main",         activity: .running,   isActive: true),
                SpaceItem(id: "catalog", name: "catalog-view", activity: .idle,      isActive: false),
            ]
        ),
        ProjectItem(
            id: "harbor", name: "harbor", isExpanded: true,
            spaces: [
                SpaceItem(id: "h-alpha", name: "alpha-branch", activity: .attention, isActive: false),
                SpaceItem(id: "h-main",  name: "main",         activity: .dormant,   isActive: false),
            ]
        ),
    ]

    var body: some View {
        CatalogSection(title: "OrpheusSpaceSwitcher", subtitle: "Standalone — 2 projects") {
            ScrollView(.vertical, showsIndicators: false) {
                OrpheusSpaceSwitcher(projects: projects, activeSpaceID: "main")
            }
            .frame(width: 240, height: 160)
            .orpheusBackground(OrpheusColor.Surface.raised)
            .orpheusCornerRadius(OrpheusRadius.card)
        }
    }
}

// MARK: - 11. OrpheusCommandPalette

struct OrpheusCommandPaletteSection: View {
    @State private var query = ""
    @State private var selected: String? = "s2"

    private var groups: [OrpheusCommandPalette.Group] {
        [
            OrpheusCommandPalette.Group(id: "sessions", title: "Sessions", items: [
                OrpheusCommandPalette.Item(id: "s1", title: "Identify CPU perf optimization",
                                           subtitle: "thoughts / My Space",
                                           icon: OrpheusIconSlot.terminal()),
                OrpheusCommandPalette.Item(id: "s2", title: "brainstorm-ide-reframe",
                                           subtitle: "thoughts / brainstorm-ide",
                                           icon: OrpheusIconSlot.terminal()),
                OrpheusCommandPalette.Item(id: "s3", title: "migrate-valorant-companion",
                                           subtitle: "thoughts / migrate-valorant",
                                           icon: OrpheusIconSlot.terminal()),
            ]),
            OrpheusCommandPalette.Group(id: "spaces", title: "Spaces", items: [
                OrpheusCommandPalette.Item(id: "sp1", title: "My Space",
                                           subtitle: "thoughts", icon: OrpheusIconSlot.space()),
                OrpheusCommandPalette.Item(id: "sp2", title: "brainstorm-ide-reframe",
                                           subtitle: "thoughts", icon: OrpheusIconSlot.space()),
            ]),
            OrpheusCommandPalette.Group(id: "actions", title: "Actions", items: [
                OrpheusCommandPalette.Item(id: "a1", title: "New Claude session",
                                           icon: OrpheusIconSlot.selfDrive(),
                                           trailingHint: "⌘↩"),
                OrpheusCommandPalette.Item(id: "a2", title: "New space",
                                           icon: OrpheusIconSlot.space(),
                                           trailingHint: "⌘N"),
                OrpheusCommandPalette.Item(id: "a3", title: "Fork current session",
                                           icon: OrpheusIconSlot.fork(),
                                           trailingHint: "⌘⇧F"),
            ]),
        ]
    }

    var body: some View {
        CatalogSection(title: "OrpheusCommandPalette", subtitle: "Pre-populated · item s2 selected") {
            ZStack {
                RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                    .fill(OrpheusColor.Surface.base.resolved)
                    .frame(height: 340)

                OrpheusCommandPalette(
                    query: $query,
                    groups: groups,
                    selectedID: $selected,
                    onSubmit: { _ in },
                    onDismiss: {}
                )
            }
            .frame(width: 560, height: 340)
        }
    }
}

// MARK: - 12. OrpheusModal

struct OrpheusModalSection: View {
    @State private var tfPath = ""
    @State private var tfName = ""

    var body: some View {
        CatalogSection(title: "OrpheusModal", subtitle: "Card-only (no scrim) — 'New project' form") {
            VStack(alignment: .leading, spacing: 0) {
                Text("New Project")
                    .orpheusFont(OrpheusTypography.title)
                    .orpheusForeground(OrpheusColor.Text.primary)
                    .padding(.bottom, OrpheusSpacing.sm)

                Divider()
                    .overlay(OrpheusColor.Border.default.resolved)
                    .padding(.bottom, OrpheusSpacing.sm)

                VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                    OrpheusText("Repository path", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                    OrpheusTextField("~/code/projects/", text: $tfPath)

                    OrpheusText("Project name", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                    OrpheusTextField("(auto from folder)", text: $tfName)

                    HStack {
                        Spacer()
                        OrpheusButton("Cancel", variant: .secondary) {}
                        OrpheusButton("Create",  variant: .primary)  {}
                    }
                    .padding(.top, OrpheusSpacing.xs)
                }
            }
            .padding(OrpheusSpacing.lg)
            .frame(width: 480)
            .orpheusMaterial(OrpheusMaterial.overlay)
            .orpheusCornerRadius(OrpheusRadius.modal)
            .overlay(
                RoundedRectangle(cornerRadius: OrpheusRadius.modal, style: .continuous)
                    .strokeBorder(OrpheusColor.Border.default.resolved, lineWidth: 1)
            )
        }
    }
}

// MARK: - 13. OrpheusSheet

struct OrpheusSheetSection: View {
    @State private var spaceName = ""

    var body: some View {
        CatalogSection(title: "OrpheusSheet", subtitle: "HeaderFooterScaffold rendered inline") {
            OrpheusSheet<AnyView>.HeaderFooterScaffold(
                title: "New space — thoughts",
                footerButtons: [
                    AnyView(OrpheusButton("Cancel", variant: .secondary) {}),
                    AnyView(OrpheusButton("Create",  variant: .primary)  {}),
                ]
            ) {
                VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                    OrpheusText("Space name", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                    OrpheusTextField("wireframe-v0-5", text: $spaceName)

                    OrpheusText("Working directory", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                    OrpheusText("Inherit from project  ~/code/projects/thoughts",
                                style: OrpheusTypography.body,
                                color: OrpheusColor.Text.secondary)

                    OrpheusText("Seed terminals", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                    OrpheusText("Claude session, Shell",
                                style: OrpheusTypography.body,
                                color: OrpheusColor.Text.primary)
                }
            }
            .padding(OrpheusSpacing.lg)
            .frame(width: 520)
            .orpheusBackground(OrpheusColor.Surface.elevated)
            .orpheusCornerRadius(OrpheusRadius.card)
        }
    }
}

// MARK: - 14. OrpheusStatusBadge

struct OrpheusStatusBadgeSection: View {
    private let kinds: [(String, OrpheusStatusBadge.Kind)] = [
        ("neutral",  .neutral),
        ("info",     .info),
        ("success",  .success),
        ("warning",  .warning),
        ("critical", .critical),
        ("accent",   .accent),
        ("live",     .live),
        ("dormant",  .dormant),
    ]
    private let styles: [(String, OrpheusStatusBadge.BadgeStyle)] = [
        ("filled",  .filled),
        ("soft",    .soft),
        ("outline", .outline),
    ]

    var body: some View {
        CatalogSection(title: "OrpheusStatusBadge", subtitle: "kind × style matrix") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
                // Header row
                HStack(spacing: OrpheusSpacing.xs) {
                    Spacer().frame(width: 72)
                    ForEach(styles, id: \.0) { name, _ in
                        OrpheusText(name, style: OrpheusTypography.caption,
                                    color: OrpheusColor.Text.tertiary)
                            .frame(width: 80, alignment: .center)
                    }
                }
                Divider()
                    .overlay(OrpheusColor.Border.subtle.resolved)

                ForEach(kinds, id: \.0) { kindName, kind in
                    HStack(spacing: OrpheusSpacing.xs) {
                        OrpheusText(kindName, style: OrpheusTypography.caption,
                                    color: OrpheusColor.Text.tertiary)
                            .frame(width: 72, alignment: .leading)
                        ForEach(styles, id: \.0) { _, style in
                            OrpheusStatusBadge(kindName, kind: kind, style: style)
                                .frame(width: 80, alignment: .center)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - 15. OrpheusTooltip

struct OrpheusTooltipSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusTooltip", subtitle: "Static bubbles — hover popover in running app") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
                HStack(spacing: OrpheusSpacing.sm) {
                    OrpheusTooltip("Above the trigger")
                    OrpheusTooltip("Below the trigger")
                    OrpheusTooltip("Leading side")
                    OrpheusTooltip("Trailing side")
                }

                OrpheusText("Hover targets (hover in running app)",
                            style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                HStack(spacing: OrpheusSpacing.sm) {
                    hoverChip("Above",    tip: "Opens above",    placement: .above)
                    hoverChip("Below",    tip: "Opens below",    placement: .below)
                    hoverChip("Leading",  tip: "Opens on left",  placement: .leading)
                    hoverChip("Trailing", tip: "Opens on right", placement: .trailing)
                }
            }
        }
    }

    private func hoverChip(_ label: String, tip: String, placement: OrpheusTooltipPlacement) -> some View {
        Text(label)
            .orpheusFont(OrpheusTypography.caption)
            .orpheusForeground(OrpheusColor.Text.secondary)
            .padding(.vertical, OrpheusSpacing.xxs)
            .padding(.horizontal, OrpheusSpacing.xs)
            .background(
                RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                    .fill(OrpheusColor.Surface.elevated.resolved)
            )
            .orpheusTooltip(tip, placement: placement)
    }
}

// MARK: - 16. OrpheusQuickAction

struct OrpheusQuickActionSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusQuickAction", subtitle: "standard · primary · ghost · disabled") {
            HStack(spacing: OrpheusSpacing.xs) {
                OrpheusQuickAction("Run tests") { }
                OrpheusQuickAction(
                    "Commit",
                    glyph: OrpheusIcon(systemName: "checkmark", size: .small,
                                       color: OrpheusColor.Text.secondary)
                ) { }
                OrpheusQuickAction("Apply", kind: .primary) { }
                OrpheusQuickAction(
                    "Ship",
                    glyph: OrpheusIcon(systemName: "paperplane.fill", size: .small,
                                       color: OrpheusColor.Text.inverted),
                    kind: .primary
                ) { }
                OrpheusQuickAction("Dismiss", kind: .ghost) { }
                OrpheusQuickAction(
                    "Settings",
                    glyph: OrpheusIcon(systemName: "gearshape", size: .small,
                                       color: OrpheusColor.Text.secondary),
                    kind: .ghost
                ) { }
                OrpheusQuickAction("Disabled", isEnabled: false) { }
            }
        }
    }
}

// MARK: - 17. OrpheusSpinner

struct OrpheusSpinnerSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusSpinner", subtitle: "small · medium · large") {
            HStack(spacing: OrpheusSpacing.xl) {
                VStack(spacing: OrpheusSpacing.xs) {
                    OrpheusSpinner(size: .small)
                    OrpheusText("small", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                }
                VStack(spacing: OrpheusSpacing.xs) {
                    OrpheusSpinner(size: .medium)
                    OrpheusText("medium", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                }
                VStack(spacing: OrpheusSpacing.xs) {
                    OrpheusSpinner(size: .large)
                    OrpheusText("large", style: OrpheusTypography.caption,
                                color: OrpheusColor.Text.tertiary)
                }
            }
        }
    }
}

// MARK: - 18. OrpheusProgressBar

struct OrpheusProgressBarSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusProgressBar", subtitle: "determinate · indeterminate · sizes") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
                OrpheusText("Determinate", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                progressRow("0 %")    { OrpheusProgressBar(progress: 0.00) }
                progressRow("35 %")   { OrpheusProgressBar(progress: 0.35) }
                progressRow("100 %")  { OrpheusProgressBar(progress: 1.00) }

                OrpheusText("Indeterminate", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                progressRow("—")      { OrpheusProgressBar() }

                OrpheusText("Sizes", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                progressRow("small")  { OrpheusProgressBar(progress: 0.6, size: .small) }
                progressRow("medium") { OrpheusProgressBar(progress: 0.6, size: .medium) }
                progressRow("large")  { OrpheusProgressBar(progress: 0.6, size: .large) }
            }
            .frame(maxWidth: 360, alignment: .leading)
        }
    }

    @ViewBuilder
    private func progressRow<V: View>(_ label: String, @ViewBuilder bar: () -> V) -> some View {
        HStack(spacing: OrpheusSpacing.sm) {
            OrpheusText(label, style: OrpheusTypography.caption,
                        color: OrpheusColor.Text.secondary)
                .frame(width: 52, alignment: .trailing)
            bar()
        }
    }
}

// MARK: - 19. OrpheusSkeleton

struct OrpheusSkeletonSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusSkeleton", subtitle: "single bars · multi-line row shape") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
                OrpheusText("Single bars", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusSkeleton(width: 240, height: 12)
                OrpheusSkeleton(width: 180, height: 20)
                OrpheusSkeleton(width: 120, height: 8)
                OrpheusSkeleton(height: 32, cornerRadius: OrpheusRadius.card)
                    .frame(width: 360)

                OrpheusText("Multi-line row (W19 shape)", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                OrpheusSkeleton.row(lines: 3)
                    .frame(width: 280)
            }
        }
    }
}

// MARK: - 20. OrpheusToast / OrpheusToastStack

struct OrpheusToastSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusToast / OrpheusToastStack",
                       subtitle: "info · success · warning · critical + stack") {
            VStack(alignment: .trailing, spacing: OrpheusSpacing.sm) {
                OrpheusToast("Connected to Anthropic API.", kind: .success,
                             title: "Connected", onDismiss: {})
                OrpheusToast("Session file not found.", kind: .critical,
                             title: "Session failed to resume", onDismiss: {})
                OrpheusToast("Rate limit approaching.", kind: .warning, onDismiss: {})
                OrpheusToast("Press ⌘K for the command palette.", kind: .info, onDismiss: {})

                Divider()
                    .overlay(OrpheusColor.Border.subtle.resolved)
                    .padding(.vertical, OrpheusSpacing.xs)

                OrpheusText("Stack (3 toasts)", style: OrpheusTypography.caption,
                            color: OrpheusColor.Text.tertiary)
                    .frame(maxWidth: .infinity, alignment: .trailing)

                OrpheusToastStack([
                    OrpheusToastItem("Build finished in 2.3 s.", kind: .success,
                                     title: "Build OK"),
                    OrpheusToastItem("Linter found 3 warnings.", kind: .warning),
                    OrpheusToastItem("Could not reach GitHub.", kind: .critical,
                                     title: "Network error"),
                ])
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

// MARK: - 21. OrpheusBanner

struct OrpheusBannerSection: View {
    var body: some View {
        CatalogSection(title: "OrpheusBanner",
                       subtitle: "info · success · warning · critical") {
            VStack(spacing: OrpheusSpacing.sm) {
                OrpheusBanner("This is for your information.", kind: .info,
                              title: "Heads up",
                              primaryAction: .init(title: "Learn more") {},
                              onDismiss: {})
                OrpheusBanner("Your session was saved successfully.", kind: .success,
                              title: "Saved",
                              primaryAction: .init(title: "View session") {},
                              onDismiss: {})
                OrpheusBanner("Rate limit approaching. Slow down requests.", kind: .warning,
                              title: "Rate limit warning",
                              primaryAction: .init(title: "Open settings") {},
                              onDismiss: {})
                OrpheusBanner("Can't reach Anthropic API. Check network or API key.", kind: .critical,
                              title: "Connection error",
                              primaryAction: .init(title: "Retry") {},
                              onDismiss: {})
                OrpheusBanner("Running in offline mode — cached sessions only.",
                              kind: .warning, isDismissable: false)
            }
            .frame(maxWidth: 520, alignment: .leading)
        }
    }
}
