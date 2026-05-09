import SwiftUI

/// Native macOS sheet wrapper styled with Orpheus tokens.
/// Uses SwiftUI's `.sheet(isPresented:)` primitive for the presentation
/// but wraps the inner body entirely in tokenized chrome.
public struct OrpheusSheet<Content: View>: View {

    @Binding private var isPresented: Bool
    private let content: () -> Content

    public init(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self._isPresented = isPresented
        self.content = content
    }

    public var body: some View {
        EmptyView()
            .sheet(isPresented: $isPresented) {
                sheetBody
            }
    }

    private var sheetBody: some View {
        content()
            .padding(OrpheusSpacing.lg)
            .frame(width: 520)
            .frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
            .orpheusBackground(OrpheusColor.Surface.elevated)
    }
}

// MARK: - Header/footer scaffold


public extension OrpheusSheet {
    /// Optional scaffold for consistent modal header + footer layout inside a sheet.
    /// Pass `title` for a heading row and `footerButtons` for trailing action buttons.
    /// The caller's `content` fills the middle.
    struct HeaderFooterScaffold<InnerContent: View>: View {

        private let title: String?
        private let footerButtons: [AnyView]
        private let innerContent: () -> InnerContent

        @Environment(\.orpheusTheme) private var theme

        public init(
            title: String? = nil,
            footerButtons: [AnyView] = [],
            @ViewBuilder content: @escaping () -> InnerContent
        ) {
            self.title = title
            self.footerButtons = footerButtons
            self.innerContent = content
        }

        public var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                if let title {
                    HStack {
                        Text(title)
                            .orpheusFont(OrpheusTypography.title)
                            .orpheusForeground(OrpheusColor.Text.primary)
                        Spacer()
                    }
                    .padding(.bottom, OrpheusSpacing.sm)

                    Divider()
                        .overlay(
                            theme.scheme == .dark
                                ? OrpheusColor.Border.default.darkColor
                                : OrpheusColor.Border.default.lightColor
                        )
                        .padding(.bottom, OrpheusSpacing.sm)
                }

                innerContent()

                if !footerButtons.isEmpty {
                    Divider()
                        .overlay(
                            theme.scheme == .dark
                                ? OrpheusColor.Border.default.darkColor
                                : OrpheusColor.Border.default.lightColor
                        )
                        .padding(.top, OrpheusSpacing.sm)

                    HStack(spacing: OrpheusSpacing.xs) {
                        Spacer()
                        ForEach(footerButtons.indices, id: \.self) { idx in
                            footerButtons[idx]
                        }
                    }
                    .padding(.top, OrpheusSpacing.sm)
                }
            }
        }
    }
}

// MARK: - View modifier

public extension View {
    func orpheusSheet<Content: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        self.sheet(isPresented: isPresented) {
            content()
                .padding(OrpheusSpacing.lg)
                .frame(width: 520)
                .frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
                .orpheusBackground(OrpheusColor.Surface.elevated)
        }
    }
}

// MARK: - Previews

// Previews render the inner content directly — `.sheet` requires a live
// app run-loop to present, so the scaffold shows the body in its styled frame.

#Preview("Sheet body · dark") {
    previewSheetContent()
        .orpheusTheme(.dark)
}

#Preview("Sheet body · light") {
    previewSheetContent()
        .orpheusTheme(.light)
}

@MainActor
private func previewSheetContent() -> some View {
    OrpheusSheet<AnyView>.HeaderFooterScaffold(
        title: "New space — thoughts",
        footerButtons: [
            AnyView(OrpheusButton("Cancel", variant: .secondary) {}),
            AnyView(OrpheusButton("Create", variant: .primary) {})
        ]
    ) {
        VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
            OrpheusText(
                "Space name",
                style: OrpheusTypography.caption,
                color: OrpheusColor.Text.tertiary
            )
            OrpheusTextField("wireframe-v0-5", text: .constant(""))

            OrpheusText(
                "Working directory",
                style: OrpheusTypography.caption,
                color: OrpheusColor.Text.tertiary
            )
            OrpheusText(
                "Inherit from project  ~/code/projects/thoughts",
                style: OrpheusTypography.body,
                color: OrpheusColor.Text.secondary
            )

            OrpheusText(
                "Seed terminals",
                style: OrpheusTypography.caption,
                color: OrpheusColor.Text.tertiary
            )
            OrpheusText(
                "Claude session, Shell",
                style: OrpheusTypography.body,
                color: OrpheusColor.Text.primary
            )
        }
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 520)
    .orpheusBackground(OrpheusColor.Surface.elevated)
}
