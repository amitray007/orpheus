import AppKit
import SwiftUI

/// Single-line text input. Wraps `NSTextField` / `NSSecureTextField` via
/// `NSViewRepresentable` so every visible pixel is token-controlled.
/// The system focus ring is suppressed; a custom SwiftUI ring takes its
/// place when the field is active.
public struct OrpheusTextField: View {

    public enum Size: Sendable, Equatable {
        case small, medium, large

        public var height: CGFloat {
            switch self {
            case .small:  return 24
            case .medium: return 28
            case .large:  return 32
            }
        }
    }

    private let placeholder: String
    @Binding private var text: String
    private let leadingIcon: OrpheusIcon?
    private let trailingContent: AnyView?
    private let isSecure: Bool
    private let isEnabled: Bool
    private let size: Size
    private let onSubmit: (() -> Void)?

    @State private var isHovered  = false
    @State private var isFocused  = false

    public init(
        _ placeholder: String,
        text: Binding<String>,
        leadingIcon: OrpheusIcon? = nil,
        trailingContent: AnyView? = nil,
        isSecure: Bool = false,
        isEnabled: Bool = true,
        size: Size = .medium,
        onSubmit: (() -> Void)? = nil
    ) {
        self.placeholder = placeholder
        self._text = text
        self.leadingIcon = leadingIcon
        self.trailingContent = trailingContent
        self.isSecure = isSecure
        self.isEnabled = isEnabled
        self.size = size
        self.onSubmit = onSubmit
    }

    public var body: some View {
        HStack(spacing: OrpheusSpacing.xxs) {
            if let leadingIcon {
                leadingIcon
                    .accessibilityHidden(true)
            }

            _NativeTextField(
                placeholder: placeholder,
                text: $text,
                isSecure: isSecure,
                isEnabled: isEnabled,
                isFocused: $isFocused,
                onSubmit: onSubmit,
                typographyStyle: OrpheusTypography.body,
                theme: theme
            )

            if let trailingContent {
                trailingContent
            }
        }
        .padding(.horizontal, OrpheusSpacing.sm)
        .frame(height: size.height)
        .background(
            RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous)
                .fill(surfaceColor)
        )
        .overlay(
            RoundedRectangle(cornerRadius: OrpheusRadius.button, style: .continuous)
                .strokeBorder(borderColor, lineWidth: 1)
        )
        // Custom focus ring — 2pt Accent.primary at +2pt offset
        .overlay(
            RoundedRectangle(cornerRadius: OrpheusRadius.button + 2, style: .continuous)
                .strokeBorder(
                    isFocused ? OrpheusColor.Accent.primary.resolved : .clear,
                    lineWidth: 2
                )
                .padding(-2)
        )
        .opacity(isEnabled ? 1.0 : 0.5)
        .onHover { hovering in
            withAnimation(OrpheusMotion.quickAnim) {
                isHovered = hovering && isEnabled
            }
        }
        .animation(OrpheusMotion.quickAnim, value: isFocused)
        .animation(OrpheusMotion.quickAnim, value: isHovered)
        .accessibilityLabel(placeholder)
        .accessibilityValue(text)
    }

    // MARK: - Color resolution

    @Environment(\.orpheusTheme) private var theme
    private var isDark: Bool { theme.scheme == .dark }

    private var surfaceColor: Color {
        isDark ? OrpheusColor.Surface.elevated.darkColor
               : OrpheusColor.Surface.elevated.lightColor
    }

    private var borderColor: Color {
        if isFocused {
            return isDark ? OrpheusColor.Accent.primary.darkColor
                          : OrpheusColor.Accent.primary.lightColor
        }
        let token = isHovered ? OrpheusColor.Border.default : OrpheusColor.Border.subtle
        return isDark ? token.darkColor : token.lightColor
    }
}

// MARK: - AppKit backing

/// NSViewRepresentable that wraps NSTextField or NSSecureTextField.
/// This type is private to the module — OrpheusTextField is the public API.
private struct _NativeTextField: NSViewRepresentable {
    let placeholder: String
    @Binding var text: String
    let isSecure: Bool
    let isEnabled: Bool
    @Binding var isFocused: Bool
    let onSubmit: (() -> Void)?
    let typographyStyle: OrpheusTypography.Style
    let theme: OrpheusTheme

    func makeNSView(context: Context) -> NSTextField {
        let field: NSTextField = isSecure
            ? NSSecureTextField()
            : NSTextField()
        field.isBezeled = false
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = typographyStyle.nsFont
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
        nsView.isEnabled = isEnabled
        nsView.font = typographyStyle.nsFont
        nsView.textColor = theme.scheme == .dark
            ? OrpheusColor.Text.primary.dark.nsColor
            : OrpheusColor.Text.primary.light.nsColor
        applyPlaceholder(to: nsView)
    }

    private func applyPlaceholder(to field: NSTextField) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: typographyStyle.nsFont,
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
        Coordinator(text: $text, isFocused: $isFocused, onSubmit: onSubmit)
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        @Binding var text: String
        @Binding var isFocused: Bool
        var onSubmit: (() -> Void)?

        init(text: Binding<String>, isFocused: Binding<Bool>, onSubmit: (() -> Void)?) {
            self._text = text
            self._isFocused = isFocused
            self.onSubmit = onSubmit
        }

        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            text = field.stringValue
        }

        func controlTextDidBeginEditing(_ obj: Notification) {
            isFocused = true
        }

        func controlTextDidEndEditing(_ obj: Notification) {
            isFocused = false
        }

        @objc func onAction(_ sender: NSTextField) {
            onSubmit?()
        }

        func control(
            _ control: NSControl,
            textView: NSTextView,
            doCommandBy commandSelector: Selector
        ) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                onSubmit?()
                return true
            }
            return false
        }
    }
}

// MARK: - Previews

#Preview("TextField · dark") {
    textFieldMatrix()
        .orpheusTheme(.dark)
}

#Preview("TextField · light") {
    textFieldMatrix()
        .orpheusTheme(.light)
}

@MainActor
private func textFieldMatrix() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
        OrpheusText("Idle", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextField("Placeholder text…", text: .constant(""))

        OrpheusText("With value", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextField("Placeholder", text: .constant("Some input value"))

        OrpheusText("With leading icon", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextField(
            "Search…",
            text: .constant(""),
            leadingIcon: OrpheusIconSlot.search()
        )

        OrpheusText("Secure", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextField("Password", text: .constant("secret"), isSecure: true)

        OrpheusText("Disabled", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextField("Disabled field", text: .constant(""), isEnabled: false)

        OrpheusText("Sizes", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextField("Small", text: .constant(""), size: .small)
        OrpheusTextField("Medium", text: .constant(""), size: .medium)
        OrpheusTextField("Large", text: .constant(""), size: .large)
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 360)
    .orpheusBackground(OrpheusColor.Surface.base)
}
