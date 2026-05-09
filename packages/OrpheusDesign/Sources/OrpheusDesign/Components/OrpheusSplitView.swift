import SwiftUI
import AppKit

/// Custom horizontal or vertical splitter with a draggable divider.
/// Implemented via `GeometryReader` + drag gesture — never wraps SwiftUI's
/// `HSplitView`/`VSplitView` whose chrome and chrome artifacts leak through.
public struct OrpheusSplitView<Leading: View, Trailing: View>: View {

    private let axis: Axis
    private let initialFraction: CGFloat
    private let minLeadingSize: CGFloat
    private let minTrailingSize: CGFloat
    private let isLeadingCollapsible: Bool
    private let isLeadingCollapsed: Binding<Bool>?
    private let leading: () -> Leading
    private let trailing: () -> Trailing

    @State private var fraction: CGFloat
    @State private var isDividerHovered = false
    @State private var isCollapsed = false

    @Environment(\.orpheusTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Width of the interactive hit-target around the hairline divider
    private let dividerHitSize: CGFloat = 8

    public init(
        axis: Axis = .horizontal,
        initialFraction: CGFloat = 0.5,
        minLeadingSize: CGFloat = 120,
        minTrailingSize: CGFloat = 120,
        isLeadingCollapsible: Bool = false,
        isLeadingCollapsed: Binding<Bool>? = nil,
        @ViewBuilder leading: @escaping () -> Leading,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.axis = axis
        self.initialFraction = initialFraction
        self.minLeadingSize = minLeadingSize
        self.minTrailingSize = minTrailingSize
        self.isLeadingCollapsible = isLeadingCollapsible
        self.isLeadingCollapsed = isLeadingCollapsed
        self.leading = leading
        self.trailing = trailing
        _fraction = State(initialValue: initialFraction)
        _isCollapsed = State(initialValue: isLeadingCollapsed?.wrappedValue ?? false)
    }

    public var body: some View {
        GeometryReader { proxy in
            let totalSize = axis == .horizontal ? proxy.size.width : proxy.size.height
            let leadingSize = computeLeadingSize(total: totalSize)
            let trailingSize = totalSize - leadingSize
            let dividerThickness: CGFloat = isDividerHovered ? 2 : 1

            if axis == .horizontal {
                HStack(spacing: 0) {
                    leading()
                        .frame(width: leadingSize)

                    dividerView(thickness: dividerThickness, total: totalSize)

                    trailing()
                        .frame(maxWidth: .infinity)
                        .frame(width: trailingSize)
                }
            } else {
                VStack(spacing: 0) {
                    leading()
                        .frame(height: leadingSize)

                    dividerView(thickness: dividerThickness, total: totalSize)

                    trailing()
                        .frame(maxHeight: .infinity)
                        .frame(height: trailingSize)
                }
            }
        }
    }

    // MARK: - Divider view

    @ViewBuilder
    private func dividerView(thickness: CGFloat, total: CGFloat) -> some View {
        let isDark = theme.scheme == .dark
        let borderToken = isDividerHovered ? OrpheusColor.Border.strong
                                           : OrpheusColor.Border.subtle
        let dividerColor = isDark ? borderToken.darkColor : borderToken.lightColor

        ZStack {
            // Invisible wide hit target so the narrow hairline is easy to grab
            Color.clear
                .frame(
                    width:  axis == .horizontal ? dividerHitSize : nil,
                    height: axis == .vertical   ? dividerHitSize : nil
                )

            // The visible hairline
            Rectangle()
                .fill(dividerColor)
                .frame(
                    width:  axis == .horizontal ? thickness : nil,
                    height: axis == .vertical   ? thickness : nil
                )
        }
        .onHover { hovering in
            withAnimation(OrpheusMotion.quickAnim) {
                isDividerHovered = hovering
            }
            if hovering {
                let cursor: NSCursor = axis == .horizontal
                    ? .resizeLeftRight
                    : .resizeUpDown
                cursor.push()
            } else {
                NSCursor.pop()
            }
        }
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { value in
                    handleDrag(translation: axis == .horizontal
                               ? value.translation.width
                               : value.translation.height,
                               total: total)
                }
                .onEnded { value in
                    handleDragEnd(translation: axis == .horizontal
                                  ? value.translation.width
                                  : value.translation.height,
                                  total: total)
                }
        )
        .accessibilityLabel(axis == .horizontal ? "Resize panes" : "Resize panels")
        .accessibilityAddTraits(.isButton)
        .animation(OrpheusMotion.quickAnim, value: isDividerHovered)
    }

    // MARK: - Size computation

    private func computeLeadingSize(total: CGFloat) -> CGFloat {
        guard total > 0 else { return 0 }
        if isCollapsed { return 0 }
        let raw = fraction * total
        // Clamp within min bounds
        let clamped = min(
            max(raw, minLeadingSize),
            total - minTrailingSize
        )
        return max(clamped, 0)
    }

    // MARK: - Drag handling

    private func handleDrag(translation: CGFloat, total: CGFloat) {
        guard total > 0 else { return }
        // If collapsed and dragging away from edge, restore immediately
        if isCollapsed && translation > 4 {
            let animation = reduceMotion ? .linear(duration: 0) : OrpheusMotion.settleAnim
            withAnimation(animation) {
                isCollapsed = false
                isLeadingCollapsed?.wrappedValue = false
            }
            fraction = minLeadingSize / total
            return
        }
        guard !isCollapsed else { return }

        let currentLeading = fraction * total
        let newLeading = currentLeading + translation
        let newFraction = newLeading / total
        // Clamp to valid range (no animation during live drag)
        let minFraction = minLeadingSize / total
        let maxFraction = (total - minTrailingSize) / total
        fraction = min(max(newFraction, minFraction), maxFraction)
    }

    private func handleDragEnd(translation: CGFloat, total: CGFloat) {
        guard total > 0 else { return }
        guard !isCollapsed else { return }

        // Snap to collapsed if leading is dragged below its minimum
        if isLeadingCollapsible {
            let leadingSize = fraction * total
            if leadingSize <= minLeadingSize {
                let animation = reduceMotion ? .linear(duration: 0) : OrpheusMotion.settleAnim
                withAnimation(animation) {
                    isCollapsed = true
                    isLeadingCollapsed?.wrappedValue = true
                }
                return
            }
        }
        // No snap needed — fraction already clamped in onChanged
    }
}

// MARK: - Previews

#Preview("SplitView · dark") {
    splitPreview().orpheusTheme(.dark)
}

#Preview("SplitView · light") {
    splitPreview().orpheusTheme(.light)
}

@MainActor
private func splitPreview() -> some View {
    VStack(spacing: 0) {
        // Horizontal split: sidebar-like left + content right
        OrpheusSplitView(
            axis: .horizontal,
            initialFraction: 0.3,
            minLeadingSize: 140,
            minTrailingSize: 200,
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
        .frame(height: 200)

        // Horizontal divider between the two split examples
        Rectangle()
            .fill(Color.clear)
            .frame(height: OrpheusSpacing.xs)

        // Vertical split: session list top + preview bottom
        OrpheusSplitView(
            axis: .vertical,
            initialFraction: 0.5,
            minLeadingSize: 80,
            minTrailingSize: 80,
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
        .frame(height: 200)
    }
    .frame(width: 580)
}
