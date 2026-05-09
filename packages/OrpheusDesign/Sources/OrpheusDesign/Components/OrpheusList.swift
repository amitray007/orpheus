import SwiftUI

// MARK: - Style enum (top-level so it can be used in EnvironmentKey)

/// Display style for `OrpheusList`.
public enum OrpheusListStyle: Sendable, Equatable {
    case inset    // rows have horizontal margins, raised bg per row
    case plain    // edge-to-edge rows on surface.base
    case sidebar  // tighter density, text.secondary default — for left panels
}

// MARK: - Environment keys

private struct OrpheusListStyleKey: EnvironmentKey {
    static let defaultValue: OrpheusListStyle? = nil
}

private struct OrpheusListItemSelectedKey: EnvironmentKey {
    static let defaultValue: Bool = false
}

public extension EnvironmentValues {
    /// The `OrpheusListStyle` applied to the enclosing list, if any.
    var orpheusListStyle: OrpheusListStyle? {
        get { self[OrpheusListStyleKey.self] }
        set { self[OrpheusListStyleKey.self] = newValue }
    }

    /// Whether the enclosing list row is currently selected.
    var orpheusListItemSelected: Bool {
        get { self[OrpheusListItemSelectedKey.self] }
        set { self[OrpheusListItemSelectedKey.self] = newValue }
    }
}

// MARK: - OrpheusList

/// Vertical list container built on `LazyVStack` + `ScrollView` — not on
/// SwiftUI's `List`, so every pixel of chrome comes from design tokens.
public struct OrpheusList<Data: RandomAccessCollection, ID: Hashable, Content: View>: View {

    // Re-export the top-level enum through the type for ergonomic call-sites:
    // `OrpheusList.Style` still works.
    public typealias Style = OrpheusListStyle

    private let data: Data
    private let id: KeyPath<Data.Element, ID>
    private let style: Style
    private let selection: Binding<ID?>?
    private let content: (Data.Element) -> Content

    @Environment(\.orpheusTheme) private var theme

    public init(
        _ data: Data,
        id: KeyPath<Data.Element, ID>,
        style: Style = .inset,
        selection: Binding<ID?>? = nil,
        @ViewBuilder content: @escaping (Data.Element) -> Content
    ) {
        self.data = data
        self.id = id
        self.style = style
        self.selection = selection
        self.content = content
    }

    public var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            LazyVStack(spacing: style == .inset ? OrpheusSpacing.xxs : 0) {
                let elements = Array(data)
                ForEach(elements.indices, id: \.self) { index in
                    let element = elements[index]
                    let elementID = element[keyPath: id]

                    rowView(for: element, elementID: elementID)

                    // Dividers: plain and sidebar only; inset uses row spacing instead
                    if style != .inset && index < elements.count - 1 {
                        Divider()
                            .overlay(dividerColor)
                    }
                }
            }
            .padding(.horizontal, style == .inset ? OrpheusSpacing.sm : 0)
            .padding(.vertical, OrpheusSpacing.xxs)
        }
        .background(listBackground)
    }

    // MARK: - Row wrapper

    @ViewBuilder
    private func rowView(for element: Data.Element, elementID: ID) -> some View {
        let isSelected = selection?.wrappedValue == elementID
        content(element)
            .background(rowBackground(isSelected: isSelected))
            .clipShape(
                RoundedRectangle(
                    cornerRadius: style == .inset ? OrpheusRadius.card : OrpheusRadius.none,
                    style: .continuous
                )
            )
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(OrpheusMotion.quickAnim) {
                    selection?.wrappedValue = (isSelected ? nil : elementID)
                }
            }
            .environment(\.orpheusListStyle, style)
            .environment(\.orpheusListItemSelected, isSelected)
    }

    // MARK: - Color resolution

    private var listBackground: Color {
        let isDark = theme.scheme == .dark
        switch style {
        case .inset, .plain:
            let token = OrpheusColor.Surface.base
            return isDark ? token.darkColor : token.lightColor
        case .sidebar:
            let token = OrpheusColor.Surface.raised
            return isDark ? token.darkColor : token.lightColor
        }
    }

    private func rowBackground(isSelected: Bool) -> Color {
        let isDark = theme.scheme == .dark
        if isSelected {
            let token = OrpheusColor.Accent.subtle
            return isDark ? token.darkColor : token.lightColor
        }
        switch style {
        case .inset:
            let token = OrpheusColor.Surface.raised
            return isDark ? token.darkColor : token.lightColor
        case .plain, .sidebar:
            return .clear
        }
    }

    private var dividerColor: Color {
        let isDark = theme.scheme == .dark
        let token = OrpheusColor.Border.subtle
        return isDark ? token.darkColor : token.lightColor
    }
}

// MARK: - Previews

private struct SampleItem: Identifiable {
    let id: Int
    let title: String
    let subtitle: String?
    let icon: String?
}

private let sampleItems: [SampleItem] = [
    SampleItem(id: 0, title: "Identify CPU perf opt", subtitle: "thoughts / My Space", icon: "star.fill"),
    SampleItem(id: 1, title: "brainstorm-ide-reframe", subtitle: "thoughts / brainstorm", icon: nil),
    SampleItem(id: 2, title: "migrate-valorant", subtitle: "thoughts / migrate", icon: "arrow.triangle.branch"),
    SampleItem(id: 3, title: "phase-1-harbor-impl", subtitle: "harbor / phase-1", icon: nil),
    SampleItem(id: 4, title: "valorant-catalog", subtitle: "radiant / catalog", icon: "folder"),
]

#Preview("List styles · dark") {
    listStyleComparison().orpheusTheme(.dark)
}

#Preview("List styles · light") {
    listStyleComparison().orpheusTheme(.light)
}

@MainActor
private func listStyleComparison() -> some View {
    @State var selection: Int? = 0
    return HStack(alignment: .top, spacing: 0) {
        VStack(alignment: .leading, spacing: 0) {
            OrpheusText("sidebar", style: OrpheusTypography.caption,
                         color: OrpheusColor.Text.tertiary)
                .padding(.horizontal, OrpheusSpacing.sm)
                .padding(.vertical, OrpheusSpacing.xxs)
            OrpheusList(sampleItems, id: \.id, style: .sidebar, selection: $selection) { item in
                OrpheusRow(
                    item.title,
                    subtitle: item.subtitle,
                    leading: item.icon.map {
                        OrpheusIcon(systemName: $0, size: .small,
                                    color: OrpheusColor.Text.secondary)
                    },
                    isSelected: selection == item.id
                )
            }
        }
        .frame(width: 180)
        .orpheusBackground(OrpheusColor.Surface.raised)

        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)

        VStack(alignment: .leading, spacing: 0) {
            OrpheusText("inset", style: OrpheusTypography.caption,
                         color: OrpheusColor.Text.tertiary)
                .padding(.horizontal, OrpheusSpacing.sm)
                .padding(.vertical, OrpheusSpacing.xxs)
            OrpheusList(sampleItems, id: \.id, style: .inset, selection: $selection) { item in
                OrpheusRow(
                    item.title,
                    subtitle: item.subtitle,
                    isSelected: selection == item.id
                )
            }
        }
        .frame(width: 200)
        .orpheusBackground(OrpheusColor.Surface.base)

        Divider()
            .orpheusForeground(OrpheusColor.Border.subtle)

        VStack(alignment: .leading, spacing: 0) {
            OrpheusText("plain", style: OrpheusTypography.caption,
                         color: OrpheusColor.Text.tertiary)
                .padding(.horizontal, OrpheusSpacing.sm)
                .padding(.vertical, OrpheusSpacing.xxs)
            OrpheusList(sampleItems, id: \.id, style: .plain, selection: $selection) { item in
                OrpheusRow(
                    item.title,
                    subtitle: item.subtitle,
                    isSelected: selection == item.id
                )
            }
        }
        .frame(width: 200)
        .orpheusBackground(OrpheusColor.Surface.base)
    }
    .frame(height: 320)
}
