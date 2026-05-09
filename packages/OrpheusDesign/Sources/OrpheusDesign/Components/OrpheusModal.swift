import SwiftUI

/// Centered modal overlay. Use `.orpheusModal(...)` on a parent view to
/// present it. The scrim covers the full parent; the card centers over it.
public struct OrpheusModal<Content: View>: View {

    @Binding private var isPresented: Bool
    private let title: String?
    private let width: CGFloat
    private let content: () -> Content

    @Environment(\.orpheusTheme) private var theme

    public init(
        isPresented: Binding<Bool>,
        title: String? = nil,
        width: CGFloat = 480,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self._isPresented = isPresented
        self.title = title
        self.width = width
        self.content = content
    }

    public var body: some View {
        ZStack {
            if isPresented {
                scrim
                    .transition(.opacity)

                card
                    .transition(
                        .scale(scale: 0.96).combined(with: .opacity)
                    )
            }
        }
        .animation(OrpheusMotion.standardAnim, value: isPresented)
        .onKeyPress(.escape) {
            isPresented = false
            return .handled
        }
    }

    // MARK: - Subviews

    private var scrim: some View {
        // Modal scrims are universally near-black regardless of theme palette;
        // no token captures "scrim" today, so the bare value is deliberate.
        Color.black.opacity(0.4)            // orpheus-allow:stock-color
            .ignoresSafeArea()
            .contentShape(Rectangle())
            .onTapGesture { isPresented = false }
            .accessibilityLabel("Dismiss modal")
            .accessibilityAddTraits(.isButton)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let title {
                Text(title)
                    .orpheusFont(OrpheusTypography.title)
                    .orpheusForeground(OrpheusColor.Text.primary)
                    .padding(.bottom, OrpheusSpacing.sm)

                Divider()
                    .overlay(
                        theme.scheme == .dark
                            ? OrpheusColor.Border.default.darkColor
                            : OrpheusColor.Border.default.lightColor
                    )
                    .padding(.bottom, OrpheusSpacing.sm)
            }

            content()
        }
        .padding(OrpheusSpacing.lg)
        .frame(width: width)
        .orpheusMaterial(OrpheusMaterial.overlay)
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
        .animation(OrpheusMotion.dramaticAnim, value: isPresented)
    }
}

// MARK: - View modifier

public extension View {
    func orpheusModal<Content: View>(
        isPresented: Binding<Bool>,
        title: String? = nil,
        width: CGFloat = 480,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        ZStack {
            self
            OrpheusModal(isPresented: isPresented, title: title, width: width, content: content)
        }
    }
}

// MARK: - Previews

#Preview("Modal · dark") {
    previewModalContent()
        .orpheusTheme(.dark)
}

#Preview("Modal · light") {
    previewModalContent()
        .orpheusTheme(.light)
}

@MainActor
private func previewModalContent() -> some View {
    ZStack {
        Rectangle()
            .orpheusBackground(OrpheusColor.Surface.base)
            .ignoresSafeArea()

        OrpheusModal(isPresented: .constant(true), title: "New Project") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                OrpheusText(
                    "Repository path",
                    style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary
                )
                OrpheusTextField("~/code/projects/", text: .constant(""))

                OrpheusText(
                    "Project name",
                    style: OrpheusTypography.caption,
                    color: OrpheusColor.Text.tertiary
                )
                OrpheusTextField("(auto from folder)", text: .constant(""))

                HStack {
                    Spacer()
                    OrpheusButton("Cancel", variant: .secondary) {}
                    OrpheusButton("Create", variant: .primary) {}
                }
                .padding(.top, OrpheusSpacing.xs)
            }
        }
    }
    .frame(width: 640, height: 480)
}
