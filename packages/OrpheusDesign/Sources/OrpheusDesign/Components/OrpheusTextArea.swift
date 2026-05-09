import AppKit
import SwiftUI

/// Multi-line text input. Wraps `NSTextView` inside `NSScrollView` via
/// `NSViewRepresentable`. Auto-grows between `minHeight` and `maxHeight`
/// as text is entered; beyond `maxHeight` the content scrolls.
///
/// Bare Return inserts a newline. Cmd-Return triggers `onSubmit`.
public struct OrpheusTextArea: View {

    private let placeholder: String
    @Binding private var text: String
    private let minHeight: CGFloat
    private let maxHeight: CGFloat
    private let isEnabled: Bool
    private let onSubmit: (() -> Void)?

    @State private var measuredHeight: CGFloat
    @State private var isFocused = false
    @State private var isHovered = false

    public init(
        _ placeholder: String,
        text: Binding<String>,
        minHeight: CGFloat = 64,
        maxHeight: CGFloat = 240,
        isEnabled: Bool = true,
        onSubmit: (() -> Void)? = nil
    ) {
        self.placeholder = placeholder
        self._text = text
        self.minHeight = minHeight
        self.maxHeight = maxHeight
        self.isEnabled = isEnabled
        self.onSubmit = onSubmit
        self._measuredHeight = State(initialValue: minHeight)
    }

    public var body: some View {
        _NativeTextArea(
            placeholder: placeholder,
            text: $text,
            isEnabled: isEnabled,
            isFocused: $isFocused,
            measuredHeight: $measuredHeight,
            minHeight: minHeight,
            maxHeight: maxHeight,
            onSubmit: onSubmit,
            typographyStyle: OrpheusTypography.body,
            theme: theme
        )
        .frame(height: clampedHeight)
        .padding(OrpheusSpacing.sm)
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
        .animation(OrpheusMotion.standardAnim, value: clampedHeight)
        .accessibilityLabel(placeholder)
        .accessibilityValue(text)
    }

    // MARK: - Helpers

    private var clampedHeight: CGFloat {
        max(minHeight, min(maxHeight, measuredHeight))
    }

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

private struct _NativeTextArea: NSViewRepresentable {
    let placeholder: String
    @Binding var text: String
    let isEnabled: Bool
    @Binding var isFocused: Bool
    @Binding var measuredHeight: CGFloat
    let minHeight: CGFloat
    let maxHeight: CGFloat
    let onSubmit: (() -> Void)?
    let typographyStyle: OrpheusTypography.Style
    let theme: OrpheusTheme

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false

        let textView = NSTextView()
        textView.isRichText = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.textContainerInset = .zero
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.font = typographyStyle.nsFont
        textView.delegate = context.coordinator
        context.coordinator.textView = textView

        scrollView.documentView = textView
        applyStyle(to: textView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        if textView.string != text {
            textView.string = text
            context.coordinator.remeasure()
        }
        textView.isEditable = isEnabled
        textView.isSelectable = isEnabled
        textView.font = typographyStyle.nsFont
        applyStyle(to: textView)
    }

    private func applyStyle(to textView: NSTextView) {
        textView.textColor = theme.scheme == .dark
            ? OrpheusColor.Text.primary.dark.nsColor
            : OrpheusColor.Text.primary.light.nsColor
        textView.insertionPointColor = theme.scheme == .dark
            ? OrpheusColor.Accent.primary.dark.nsColor
            : OrpheusColor.Accent.primary.light.nsColor
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            text: $text,
            isFocused: $isFocused,
            measuredHeight: $measuredHeight,
            minHeight: minHeight,
            maxHeight: maxHeight,
            placeholder: placeholder,
            onSubmit: onSubmit,
            typographyStyle: typographyStyle,
            theme: theme
        )
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        @Binding var isFocused: Bool
        @Binding var measuredHeight: CGFloat
        let minHeight: CGFloat
        let maxHeight: CGFloat
        let placeholder: String
        let onSubmit: (() -> Void)?
        let typographyStyle: OrpheusTypography.Style
        let theme: OrpheusTheme

        weak var textView: NSTextView?

        init(
            text: Binding<String>,
            isFocused: Binding<Bool>,
            measuredHeight: Binding<CGFloat>,
            minHeight: CGFloat,
            maxHeight: CGFloat,
            placeholder: String,
            onSubmit: (() -> Void)?,
            typographyStyle: OrpheusTypography.Style,
            theme: OrpheusTheme
        ) {
            self._text = text
            self._isFocused = isFocused
            self._measuredHeight = measuredHeight
            self.minHeight = minHeight
            self.maxHeight = maxHeight
            self.placeholder = placeholder
            self.onSubmit = onSubmit
            self.typographyStyle = typographyStyle
            self.theme = theme
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            text = tv.string
            remeasure()
            updatePlaceholder()
        }

        func textDidBeginEditing(_ notification: Notification) {
            isFocused = true
            updatePlaceholder()
        }

        func textDidEndEditing(_ notification: Notification) {
            isFocused = false
            updatePlaceholder()
        }

        /// Returns true when the text view should handle a keyDown event itself.
        func textView(
            _ textView: NSTextView,
            doCommandBy commandSelector: Selector
        ) -> Bool {
            // Cmd-Return → submit; bare Return → newline (default)
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                let flags = NSApp.currentEvent?.modifierFlags ?? []
                if flags.contains(.command) {
                    onSubmit?()
                    return true
                }
            }
            return false
        }

        func remeasure() {
            guard let tv = textView,
                  let lm = tv.layoutManager,
                  let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let used = lm.usedRect(for: tc)
            let newHeight = max(minHeight, min(maxHeight, ceil(used.height)))
            if newHeight != measuredHeight {
                measuredHeight = newHeight
            }
        }

        func updatePlaceholder() {
            guard let tv = textView else { return }
            let isEmpty = tv.string.isEmpty
            if isEmpty && !isFocused {
                let placeholderColor = theme.scheme == .dark
                    ? OrpheusColor.Text.tertiary.dark.nsColor
                    : OrpheusColor.Text.tertiary.light.nsColor
                tv.string = ""
                // Draw placeholder via attributed string trick on the text storage
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: typographyStyle.nsFont,
                    .foregroundColor: placeholderColor
                ]
                let ph = NSAttributedString(string: placeholder, attributes: attrs)
                tv.textStorage?.setAttributedString(ph)
                tv.isEditable = false  // prevent editing of placeholder text
            } else if !isEmpty || isFocused {
                if !tv.isEditable {
                    tv.isEditable = true
                    // Clear placeholder text if it matches
                    if tv.string == placeholder {
                        tv.string = ""
                    }
                }
                let textColor = theme.scheme == .dark
                    ? OrpheusColor.Text.primary.dark.nsColor
                    : OrpheusColor.Text.primary.light.nsColor
                tv.textColor = textColor
            }
        }
    }
}

// MARK: - Previews

#Preview("TextArea · dark") {
    textAreaMatrix()
        .orpheusTheme(.dark)
}

#Preview("TextArea · light") {
    textAreaMatrix()
        .orpheusTheme(.light)
}

@MainActor
private func textAreaMatrix() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
        OrpheusText("Empty / placeholder", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextArea("Write something…", text: .constant(""))

        OrpheusText("With content", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextArea(
            "Write something…",
            text: .constant("Line one\nLine two\nLine three — the area has grown to fit this content.")
        )

        OrpheusText("Disabled", style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        OrpheusTextArea("Disabled area", text: .constant("Can't touch this."), isEnabled: false)
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 400)
    .orpheusBackground(OrpheusColor.Surface.base)
}
