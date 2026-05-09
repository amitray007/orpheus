import SwiftUI

/// Custom toggle control: checkbox, radio button, or pill switch.
/// No `Toggle {}` in sight — every pixel is token-drawn.
public struct OrpheusToggle: View {

    public enum Style: Sendable, Equatable {
        case checkbox
        case radio
        case `switch`
    }

    private let style: Style
    @Binding private var isOn: Bool
    private let isEnabled: Bool
    private let label: String?

    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    public init(
        _ style: Style = .checkbox,
        isOn: Binding<Bool>,
        isEnabled: Bool = true,
        label: String? = nil
    ) {
        self.style = style
        self._isOn = isOn
        self.isEnabled = isEnabled
        self.label = label
    }

    public var body: some View {
        HStack(spacing: OrpheusSpacing.xs) {
            control
                .opacity(isEnabled ? 1.0 : 0.5)
                .onTapGesture { toggle() }
                .onHover { hovering in
                    withAnimation(OrpheusMotion.quickAnim) {
                        isHovered = hovering && isEnabled
                    }
                }
                .focusable()
                .focused($isFocused)
                .onKeyPress(.space) {
                    toggle()
                    return .handled
                }
                .accessibilityLabel(label ?? accessibilityDefaultLabel)
                .accessibilityValue(isOn ? "on" : "off")
                .accessibilityAddTraits(style == .radio ? .isButton : .isButton)

            if let label {
                OrpheusText(label, style: OrpheusTypography.body, color: isEnabled
                    ? OrpheusColor.Text.primary
                    : OrpheusColor.Text.disabled)
                    .onTapGesture { toggle() }
            }
        }
    }

    // MARK: - Per-style rendering

    @ViewBuilder
    private var control: some View {
        switch style {
        case .checkbox: checkboxView
        case .radio:    radioView
        case .switch:   switchView
        }
    }

    private var checkboxView: some View {
        ZStack {
            RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                .fill(isOn ? checkboxFill : Color.clear)
                .frame(width: 16, height: 16)
            RoundedRectangle(cornerRadius: OrpheusRadius.chip, style: .continuous)
                .strokeBorder(borderColor, lineWidth: 1)
                .frame(width: 16, height: 16)
            if isOn {
                OrpheusIconSlot.check(size: .small, color: OrpheusColor.Text.inverted)
            }
        }
        .focusRingOverlay(isFocused: isFocused, cornerRadius: OrpheusRadius.chip)
        .animation(OrpheusMotion.quickAnim, value: isOn)
    }

    private var radioView: some View {
        ZStack {
            Circle()
                .strokeBorder(borderColor, lineWidth: 1)
                .frame(width: 16, height: 16)
            if isOn {
                Circle()
                    .fill(accentColor)
                    .frame(width: 8, height: 8)
            }
        }
        .focusRingOverlay(isFocused: isFocused, cornerRadius: 8)
        .animation(OrpheusMotion.quickAnim, value: isOn)
    }

    private var switchView: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                .fill(isOn ? accentColor : trackColor)
                .frame(width: 36, height: 20)
            // Knob — 2pt inset from track edges
            Circle()
                .fill(knobColor)
                .frame(width: 16, height: 16)
                .padding(.horizontal, 2)
                .animation(OrpheusMotion.standardAnim, value: isOn)
        }
        .frame(width: 36, height: 20)
        .focusRingOverlay(isFocused: isFocused, cornerRadius: OrpheusRadius.pill)
    }

    // MARK: - Color resolution

    @Environment(\.orpheusTheme) private var theme
    private var isDark: Bool { theme.scheme == .dark }

    private var accentColor: Color {
        isDark ? OrpheusColor.Accent.primary.darkColor
               : OrpheusColor.Accent.primary.lightColor
    }

    private var checkboxFill: Color { accentColor }

    private var trackColor: Color {
        isDark ? OrpheusColor.Border.default.darkColor
               : OrpheusColor.Border.default.lightColor
    }

    private var knobColor: Color {
        isDark ? OrpheusColor.Surface.base.darkColor
               : OrpheusColor.Surface.base.lightColor
    }

    private var borderColor: Color {
        let token = isHovered ? OrpheusColor.Border.strong : OrpheusColor.Border.default
        return isDark ? token.darkColor : token.lightColor
    }

    private var accessibilityDefaultLabel: String {
        switch style {
        case .checkbox: return "Checkbox"
        case .radio:    return "Radio button"
        case .switch:   return "Switch"
        }
    }

    private func toggle() {
        guard isEnabled else { return }
        isOn.toggle()
    }
}

// MARK: - Focus ring helper

private extension View {
    /// Draws the Orpheus custom focus ring — 2pt Accent.primary outline
    /// at +2pt offset from the control boundary.
    func focusRingOverlay(isFocused: Bool, cornerRadius: CGFloat) -> some View {
        self.overlay(
            RoundedRectangle(cornerRadius: cornerRadius + 2, style: .continuous)
                .strokeBorder(
                    isFocused ? OrpheusColor.Accent.primary.resolved : .clear,
                    lineWidth: 2
                )
                .padding(-2)
        )
    }
}

// MARK: - Previews

#Preview("Toggle · dark") {
    toggleMatrix()
        .orpheusTheme(.dark)
}

#Preview("Toggle · light") {
    toggleMatrix()
        .orpheusTheme(.light)
}

@MainActor
private func toggleMatrix() -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
        styleBlock(name: "checkbox", style: .checkbox)
        styleBlock(name: "radio",    style: .radio)
        styleBlock(name: "switch",   style: .switch)
    }
    .padding(OrpheusSpacing.lg)
    .frame(width: 480, alignment: .leading)
    .orpheusBackground(OrpheusColor.Surface.base)
}

@MainActor
private func styleBlock(name: String, style: OrpheusToggle.Style) -> some View {
    VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
        OrpheusText(name, style: OrpheusTypography.caption, color: OrpheusColor.Text.tertiary)
        HStack(spacing: OrpheusSpacing.lg) {
            OrpheusToggle(style, isOn: .constant(false))
            OrpheusToggle(style, isOn: .constant(true))
            OrpheusToggle(style, isOn: .constant(false), label: "Off label")
            OrpheusToggle(style, isOn: .constant(true),  label: "On label")
            OrpheusToggle(style, isOn: .constant(true),  isEnabled: false, label: "Disabled")
        }
    }
}
