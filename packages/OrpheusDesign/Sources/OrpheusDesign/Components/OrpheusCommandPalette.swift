import AppKit
import SwiftUI

/// ⌘K command palette overlay. Fixed 560pt width, max 480pt height.
/// Material: `.palette` (heaviest blur + rim lighting — "floating above").
public struct OrpheusCommandPalette: View {

    public struct Item: Identifiable, Sendable, Hashable {
        public let id: String
        public let title: String
        public let subtitle: String?
        public let icon: OrpheusIcon?
        public let trailingHint: String?

        public init(
            id: String,
            title: String,
            subtitle: String? = nil,
            icon: OrpheusIcon? = nil,
            trailingHint: String? = nil
        ) {
            self.id = id
            self.title = title
            self.subtitle = subtitle
            self.icon = icon
            self.trailingHint = trailingHint
        }

        public func hash(into hasher: inout Hasher) { hasher.combine(id) }
        public static func == (lhs: Item, rhs: Item) -> Bool { lhs.id == rhs.id }
    }

    public struct Group: Identifiable, Sendable {
        public let id: String
        public let title: String
        public let items: [Item]

        public init(id: String, title: String, items: [Item]) {
            self.id = id
            self.title = title
            self.items = items
        }
    }

    @Binding private var query: String
    private let groups: [Group]
    @Binding private var selectedID: Item.ID?
    private let onSubmit: (Item.ID) -> Void
    private let onDismiss: () -> Void

    @Environment(\.orpheusTheme) private var theme
    @State private var isVisible = false

    public init(
        query: Binding<String>,
        groups: [Group],
        selectedID: Binding<Item.ID?>,
        onSubmit: @escaping (Item.ID) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self._query = query
        self.groups = groups
        self._selectedID = selectedID
        self.onSubmit = onSubmit
        self.onDismiss = onDismiss
    }

    // MARK: - Body

    public var body: some View {
        VStack(spacing: 0) {
            searchRow
            divider
            resultsArea
        }
        .frame(width: 560)
        .frame(maxHeight: 480)
        .orpheusMaterial(OrpheusMaterial.palette)
        .clipShape(
            RoundedRectangle(cornerRadius: OrpheusRadius.modal, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: OrpheusRadius.modal, style: .continuous)
                .strokeBorder(
                    theme.scheme == .dark
                        ? OrpheusColor.Border.default.darkColor
                        : OrpheusColor.Border.default.lightColor,
                    lineWidth: 1
                )
        )
        .scaleEffect(isVisible ? 1.0 : 0.96)
        .opacity(isVisible ? 1.0 : 0)
        .animation(OrpheusMotion.dramaticAnim, value: isVisible)
        .onAppear { isVisible = true }
        .onKeyPress(.upArrow)    { moveSelection(by: -1); return .handled }
        .onKeyPress(.downArrow)  { moveSelection(by:  1); return .handled }
        .onKeyPress(.return)     { submitSelection(); return .handled }
        .onKeyPress(.escape)     { onDismiss(); return .handled }
        .accessibilityLabel("Command palette")
    }

    // MARK: - Search row

    private var searchRow: some View {
        HStack(spacing: OrpheusSpacing.xs) {
            OrpheusIconSlot.search(size: .medium, color: OrpheusColor.Text.tertiary)
                .accessibilityHidden(true)

            PaletteSearchInput(
                placeholder: "Search…",
                text: $query,
                theme: theme
            )
        }
        .padding(.horizontal, OrpheusSpacing.sm)
        .padding(.vertical, OrpheusSpacing.sm)
    }

    // MARK: - Divider

    private var divider: some View {
        Rectangle()
            .fill(
                theme.scheme == .dark
                    ? OrpheusColor.Border.subtle.darkColor
                    : OrpheusColor.Border.subtle.lightColor
            )
            .frame(height: 1)
    }

    // MARK: - Results scroll area

    private var resultsArea: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(groups) { group in
                    if !group.items.isEmpty {
                        groupSection(group)
                    }
                }
            }
            .padding(.vertical, OrpheusSpacing.xs)
        }
    }

    @ViewBuilder
    private func groupSection(_ group: Group) -> some View {
        Text(group.title)
            .orpheusFont(OrpheusTypography.caption)
            .orpheusForeground(OrpheusColor.Text.tertiary)
            .padding(.horizontal, OrpheusSpacing.sm)
            .padding(.vertical, OrpheusSpacing.xs)

        ForEach(group.items) { item in
            itemRow(item)
        }
    }

    @ViewBuilder
    private func itemRow(_ item: Item) -> some View {
        let isSelected = selectedID == item.id

        HStack(spacing: OrpheusSpacing.xs) {
            if let icon = item.icon {
                icon
                    .accessibilityHidden(true)
            } else {
                // Reserve icon slot width so text aligns uniformly
                Spacer()
                    .frame(width: OrpheusIcon.Size.medium.pointSize)
            }

            VStack(alignment: .leading, spacing: 0) {
                Text(item.title)
                    .orpheusFont(OrpheusTypography.body)
                    .orpheusForeground(OrpheusColor.Text.primary)
                    .lineLimit(1)

                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .orpheusFont(OrpheusTypography.caption)
                        .orpheusForeground(OrpheusColor.Text.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if let hint = item.trailingHint {
                Text(hint)
                    .font(OrpheusTypography.caption.font)
                    // Use mono for keyboard shortcut alignment (tabular digit rendering)
                    .monospacedDigit()
                    .orpheusForeground(OrpheusColor.Text.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, OrpheusSpacing.sm)
        .frame(height: 36)
        .background(
            RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                .fill(
                    isSelected
                        ? (theme.scheme == .dark
                           ? OrpheusColor.Accent.subtle.darkColor
                           : OrpheusColor.Accent.subtle.lightColor)
                        : .clear
                )
                .padding(.horizontal, OrpheusSpacing.xs)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            selectedID = item.id
            onSubmit(item.id)
        }
        .accessibilityLabel(
            [item.title, item.subtitle].compactMap { $0 }.joined(separator: ", ")
        )
        .accessibilityAddTraits(.isButton)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .animation(OrpheusMotion.quickAnim, value: isSelected)
    }

    // MARK: - Keyboard navigation helpers

    private var flatItems: [Item] {
        groups.flatMap(\.items)
    }

    private func moveSelection(by delta: Int) {
        let items = flatItems
        guard !items.isEmpty else { return }
        if let current = selectedID,
           let idx = items.firstIndex(where: { $0.id == current }) {
            let next = (idx + delta + items.count) % items.count
            selectedID = items[next].id
        } else {
            selectedID = delta >= 0 ? items.first?.id : items.last?.id
        }
    }

    private func submitSelection() {
        if let id = selectedID {
            onSubmit(id)
        }
    }
}

// MARK: - Borderless search input (NSViewRepresentable)

/// Large, borderless search input for the palette's top row.
/// No border chrome — the palette card is the container. Font: `heading`.
private struct PaletteSearchInput: NSViewRepresentable {
    let placeholder: String
    @Binding var text: String
    let theme: OrpheusTheme

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.isBezeled = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = OrpheusTypography.heading.nsFont
        field.delegate = context.coordinator
        field.target = context.coordinator
        field.action = #selector(Coordinator.onAction(_:))
        applyPlaceholder(to: field)
        return field
    }

    func updateNSView(_ nsView: NSTextField, context: Context) {
        if nsView.stringValue != text {
            nsView.stringValue = text
        }
        nsView.font = OrpheusTypography.heading.nsFont
        nsView.textColor = theme.scheme == .dark
            ? OrpheusColor.Text.primary.dark.nsColor
            : OrpheusColor.Text.primary.light.nsColor
        applyPlaceholder(to: nsView)
    }

    private func applyPlaceholder(to field: NSTextField) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: OrpheusTypography.heading.nsFont,
            .foregroundColor: theme.scheme == .dark
                ? OrpheusColor.Text.tertiary.dark.nsColor
                : OrpheusColor.Text.tertiary.light.nsColor
        ]
        field.placeholderAttributedString = NSAttributedString(
            string: placeholder,
            attributes: attrs
        )
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        @Binding var text: String

        init(text: Binding<String>) {
            self._text = text
        }

        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            text = field.stringValue
        }

        @objc func onAction(_ sender: NSTextField) {}
    }
}

// MARK: - Previews

#Preview("Command palette · dark") {
    palettePreview()
        .orpheusTheme(.dark)
}

#Preview("Command palette · light") {
    palettePreview()
        .orpheusTheme(.light)
}

@MainActor
private func palettePreview() -> some View {
    let sessions = OrpheusCommandPalette.Group(
        id: "sessions",
        title: "Sessions",
        items: [
            OrpheusCommandPalette.Item(
                id: "s1",
                title: "Identify CPU perf optimization",
                subtitle: "thoughts / My Space",
                icon: OrpheusIconSlot.terminal(),
                trailingHint: nil
            ),
            OrpheusCommandPalette.Item(
                id: "s2",
                title: "brainstorm-ide-reframe",
                subtitle: "thoughts / brainstorm-ide-r..",
                icon: OrpheusIconSlot.terminal(),
                trailingHint: nil
            ),
            OrpheusCommandPalette.Item(
                id: "s3",
                title: "migrate-valorant-companion",
                subtitle: "thoughts / migrate-valorant",
                icon: OrpheusIconSlot.terminal(),
                trailingHint: nil
            )
        ]
    )

    let spaces = OrpheusCommandPalette.Group(
        id: "spaces",
        title: "Spaces",
        items: [
            OrpheusCommandPalette.Item(
                id: "sp1",
                title: "My Space",
                subtitle: "thoughts",
                icon: OrpheusIconSlot.space(),
                trailingHint: nil
            ),
            OrpheusCommandPalette.Item(
                id: "sp2",
                title: "brainstorm-ide-reframe",
                subtitle: "thoughts",
                icon: OrpheusIconSlot.space(),
                trailingHint: nil
            )
        ]
    )

    let actions = OrpheusCommandPalette.Group(
        id: "actions",
        title: "Actions",
        items: [
            OrpheusCommandPalette.Item(
                id: "a1",
                title: "New Claude session",
                subtitle: nil,
                icon: OrpheusIconSlot.selfDrive(),
                trailingHint: "⌘↩"
            ),
            OrpheusCommandPalette.Item(
                id: "a2",
                title: "New space",
                subtitle: nil,
                icon: OrpheusIconSlot.space(),
                trailingHint: "⌘N"
            ),
            OrpheusCommandPalette.Item(
                id: "a3",
                title: "Fork current session",
                subtitle: nil,
                icon: OrpheusIconSlot.fork(),
                trailingHint: "⌘⇧F"
            )
        ]
    )

    return ZStack {
        Rectangle()
            .orpheusBackground(OrpheusColor.Surface.base)
            .ignoresSafeArea()

        OrpheusCommandPalette(
            query: .constant(""),
            groups: [sessions, spaces, actions],
            selectedID: .constant("s2"),
            onSubmit: { _ in },
            onDismiss: {}
        )
    }
    .frame(width: 720, height: 600)
}
