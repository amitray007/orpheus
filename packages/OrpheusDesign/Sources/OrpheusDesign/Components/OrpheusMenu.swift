import SwiftUI

/// Custom popover dropdown menu. Does NOT use SwiftUI's `Menu` — the
/// popover, rows, keyboard navigation, and all chrome are token-drawn.
public struct OrpheusMenu<Trigger: View>: View {

    // MARK: - Public types

    public struct Item: Identifiable {
        public let id: UUID
        public let title: String
        public let icon: OrpheusIcon?
        public let kind: Kind
        public let isEnabled: Bool

        public init(
            title: String,
            icon: OrpheusIcon? = nil,
            kind: Kind,
            isEnabled: Bool = true
        ) {
            self.id = UUID()
            self.title = title
            self.icon = icon
            self.kind = kind
            self.isEnabled = isEnabled
        }

        public enum Kind {
            case action(() -> Void)
            case separator
            case header(String)
        }
    }

    // MARK: - State

    private let items: [Item]
    private let trigger: () -> Trigger

    @State private var isOpen = false
    @State private var highlightedIndex: Int? = nil

    public init(
        items: [Item],
        @ViewBuilder trigger: @escaping () -> Trigger
    ) {
        self.items = items
        self.trigger = trigger
    }

    // MARK: - Body

    public var body: some View {
        trigger()
            .onTapGesture {
                withAnimation(OrpheusMotion.standardAnim) {
                    isOpen.toggle()
                    if !isOpen { highlightedIndex = nil }
                }
            }
            .accessibilityLabel("Menu")
            .accessibilityAddTraits(.isButton)
            .popover(
                isPresented: $isOpen,
                attachmentAnchor: .point(.bottomLeading),
                arrowEdge: .top
            ) {
                popoverContent
            }
    }

    // MARK: - Popover content

    @ViewBuilder
    private var popoverContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                itemRow(item: item, index: index)
            }
        }
        .frame(width: 240)
        .padding(.vertical, OrpheusSpacing.xxs)
        .orpheusMaterial(OrpheusMaterial.overlay)
        .onKeyPress(.upArrow) {
            moveHighlight(by: -1)
            return .handled
        }
        .onKeyPress(.downArrow) {
            moveHighlight(by: +1)
            return .handled
        }
        .onKeyPress(.return) {
            triggerHighlighted()
            return .handled
        }
        .onKeyPress(.escape) {
            withAnimation(OrpheusMotion.quickAnim) { isOpen = false }
            return .handled
        }
    }

    @ViewBuilder
    private func itemRow(item: Item, index: Int) -> some View {
        switch item.kind {
        case .separator:
            separatorRow

        case .header(let text):
            headerRow(text: text)

        case .action(let handler):
            actionRow(item: item, index: index, handler: handler)
        }
    }

    private var separatorRow: some View {
        Rectangle()
            .fill(isDark
                  ? OrpheusColor.Border.subtle.darkColor
                  : OrpheusColor.Border.subtle.lightColor)
            .frame(height: 1)
            .padding(.vertical, OrpheusSpacing.xs)
            .padding(.horizontal, OrpheusSpacing.sm)
    }

    private func headerRow(text: String) -> some View {
        OrpheusText(text,
                    style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary)
            .padding(.horizontal, OrpheusSpacing.sm)
            .padding(.top, OrpheusSpacing.xxs)
            .padding(.bottom, OrpheusSpacing.xxs)
    }

    private func actionRow(item: Item, index: Int, handler: @escaping () -> Void) -> some View {
        let isHighlighted = highlightedIndex == index
        return HStack(spacing: OrpheusSpacing.xs) {
            if let icon = item.icon {
                icon
                    .accessibilityHidden(true)
            }
            OrpheusText(item.title,
                        style: OrpheusTypography.body,
                        color: item.isEnabled
                            ? OrpheusColor.Text.primary
                            : OrpheusColor.Text.disabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, OrpheusSpacing.sm)
        .frame(height: 28)
        .background(
            RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                .fill(rowBackground(isHighlighted: isHighlighted, isEnabled: item.isEnabled))
                .padding(.horizontal, OrpheusSpacing.xxs)
        )
        .opacity(item.isEnabled ? 1.0 : 0.5)
        .onHover { hovering in
            withAnimation(OrpheusMotion.quickAnim) {
                highlightedIndex = (hovering && item.isEnabled) ? index : nil
            }
        }
        .onTapGesture {
            guard item.isEnabled else { return }
            handler()
            withAnimation(OrpheusMotion.quickAnim) {
                isOpen = false
                highlightedIndex = nil
            }
        }
        .accessibilityLabel(item.title)
        .accessibilityAddTraits(.isButton)
        .disabled(!item.isEnabled)
    }

    // MARK: - Keyboard navigation helpers

    private func moveHighlight(by delta: Int) {
        let actionIndices = items.enumerated().compactMap { index, item -> Int? in
            if case .action = item.kind, item.isEnabled { return index } else { return nil }
        }
        guard !actionIndices.isEmpty else { return }
        if let current = highlightedIndex,
           let pos = actionIndices.firstIndex(of: current) {
            let next = (pos + delta + actionIndices.count) % actionIndices.count
            highlightedIndex = actionIndices[next]
        } else {
            highlightedIndex = delta > 0 ? actionIndices.first : actionIndices.last
        }
    }

    private func triggerHighlighted() {
        guard let idx = highlightedIndex,
              idx < items.count else { return }
        let item = items[idx]
        guard case .action(let handler) = item.kind, item.isEnabled else { return }
        handler()
        withAnimation(OrpheusMotion.quickAnim) {
            isOpen = false
            highlightedIndex = nil
        }
    }

    // MARK: - Helpers

    @Environment(\.orpheusTheme) private var theme
    private var isDark: Bool { theme.scheme == .dark }

    private func rowBackground(isHighlighted: Bool, isEnabled: Bool) -> Color {
        guard isHighlighted, isEnabled else { return .clear }
        return isDark
            ? OrpheusColor.Accent.subtle.darkColor
            : OrpheusColor.Accent.subtle.lightColor
    }
}

// MARK: - Previews

#Preview("Menu · dark") {
    menuPreview()
        .orpheusTheme(.dark)
}

#Preview("Menu · light") {
    menuPreview()
        .orpheusTheme(.light)
}

@MainActor
private func menuPreview() -> some View {
    let items: [OrpheusMenu<OrpheusButton>.Item] = [
        .init(title: "Options", kind: .header("Options")),
        .init(
            title: "New File",
            icon: OrpheusIconSlot.project(size: .small),
            kind: .action({ print("New File") })
        ),
        .init(
            title: "Open Terminal",
            icon: OrpheusIconSlot.terminal(size: .small),
            kind: .action({ print("Open Terminal") })
        ),
        .init(title: "---", kind: .separator),
        .init(title: "Actions", kind: .header("Actions")),
        .init(
            title: "Fork Pane",
            icon: OrpheusIconSlot.fork(size: .small),
            kind: .action({ print("Fork Pane") })
        ),
        .init(
            title: "Disabled Action",
            kind: .action({ print("Disabled") }),
            isEnabled: false
        ),
        .init(title: "---", kind: .separator),
        .init(
            title: "Search",
            icon: OrpheusIconSlot.search(size: .small),
            kind: .action({ print("Search") })
        )
    ]

    return VStack {
        OrpheusMenu(items: items) {
            OrpheusButton("Open menu", variant: .secondary) { }
        }
    }
    .padding(OrpheusSpacing.xl)
    .frame(width: 360, height: 240)
    .orpheusBackground(OrpheusColor.Surface.base)
}
