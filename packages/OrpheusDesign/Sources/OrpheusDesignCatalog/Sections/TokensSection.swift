import SwiftUI
import OrpheusDesign

// MARK: - All token sections aggregated

struct TokensSection: View {
    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.lg) {
            ColorsSection()
            TypographySection()
            SpacingSection()
            RadiusSection()
            MotionSection()
            MaterialsSection()
            IconsSection()
        }
    }
}

// MARK: - 1. Colors

private struct ColorSwatch: View {
    let name: String
    let color: OrpheusThemedColor
    let showsAlpha: Bool

    @Environment(\.orpheusTheme) private var theme
    private var isDark: Bool { theme.scheme == .dark }

    init(_ name: String, _ color: OrpheusThemedColor, showsAlpha: Bool = false) {
        self.name = name
        self.color = color
        self.showsAlpha = showsAlpha
    }

    var body: some View {
        VStack(spacing: OrpheusSpacing.xxs) {
            ZStack {
                if showsAlpha {
                    // Checkerboard so alpha is visible
                    CheckerboardPattern(cellSize: 6)
                        .frame(width: 56, height: 56)
                        .orpheusCornerRadius(OrpheusRadius.card)
                }
                RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                    .fill(isDark ? color.darkColor : color.lightColor)
                    .frame(width: 56, height: 56)
                    .overlay(
                        RoundedRectangle(cornerRadius: OrpheusRadius.card, style: .continuous)
                            .strokeBorder(OrpheusColor.Border.subtle.resolved, lineWidth: 1)
                    )
            }
            Text(name)
                .orpheusFont(OrpheusTypography.caption)
                .orpheusForeground(OrpheusColor.Text.tertiary)
                .frame(width: 56)
                .multilineTextAlignment(.center)
        }
    }
}

private struct CheckerboardPattern: View {
    let cellSize: CGFloat
    var body: some View {
        Canvas { ctx, size in
            let rows = Int(ceil(size.height / cellSize))
            let cols = Int(ceil(size.width  / cellSize))
            // orpheus-allow:stock-color (checkerboard visualization helper only)
            for row in 0..<rows {
                for col in 0..<cols {
                    let rect = CGRect(x: CGFloat(col) * cellSize,
                                      y: CGFloat(row) * cellSize,
                                      width: cellSize, height: cellSize)
                    let isLight = (row + col) % 2 == 0
                    ctx.fill(Path(rect), with: .color(isLight ? .white : Color(white: 0.75)))
                }
            }
        }
    }
}

struct ColorsSection: View {
    private struct Group {
        let name: String
        let swatches: [(String, OrpheusThemedColor, Bool)]
    }

    private let groups: [Group] = [
        Group(name: "Surface", swatches: [
            ("base",     OrpheusColor.Surface.base,     false),
            ("raised",   OrpheusColor.Surface.raised,   false),
            ("elevated", OrpheusColor.Surface.elevated, false),
            ("overlay",  OrpheusColor.Surface.overlay,  false),
        ]),
        Group(name: "Text", swatches: [
            ("primary",   OrpheusColor.Text.primary,   false),
            ("secondary", OrpheusColor.Text.secondary, false),
            ("tertiary",  OrpheusColor.Text.tertiary,  false),
            ("disabled",  OrpheusColor.Text.disabled,  false),
            ("inverted",  OrpheusColor.Text.inverted,  false),
        ]),
        Group(name: "Border", swatches: [
            ("subtle",   OrpheusColor.Border.subtle,           false),
            ("default",  OrpheusColor.Border.default,          false),
            ("strong",   OrpheusColor.Border.strong,           false),
        ]),
        Group(name: "Accent", swatches: [
            ("primary", OrpheusColor.Accent.primary, false),
            ("hover",   OrpheusColor.Accent.hover,   false),
            ("pressed", OrpheusColor.Accent.pressed, false),
            ("subtle",  OrpheusColor.Accent.subtle,  false),
        ]),
        Group(name: "Semantic", swatches: [
            ("success",  OrpheusColor.Semantic.success,  false),
            ("warning",  OrpheusColor.Semantic.warning,  false),
            ("critical", OrpheusColor.Semantic.critical, false),
            ("info",     OrpheusColor.Semantic.info,     false),
        ]),
        Group(name: "Glass", swatches: [
            ("tint",      OrpheusColor.Glass.tint,      true),
            ("highlight", OrpheusColor.Glass.highlight, true),
        ]),
    ]

    var body: some View {
        CatalogSection(title: "Colors", subtitle: "Theme-resolved semantic palette") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.md) {
                ForEach(groups, id: \.name) { group in
                    VStack(alignment: .leading, spacing: OrpheusSpacing.xs) {
                        Text(group.name)
                            .orpheusFont(OrpheusTypography.caption)
                            .orpheusForeground(OrpheusColor.Text.tertiary)
                        HStack(spacing: OrpheusSpacing.sm) {
                            ForEach(group.swatches, id: \.0) { name, color, alpha in
                                ColorSwatch(name, color, showsAlpha: alpha)
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - 2. Typography

struct TypographySection: View {
    private let ramp: [(String, OrpheusTypography.Style)] = OrpheusTypography.all

    var body: some View {
        CatalogSection(title: "Typography", subtitle: "6-step Satoshi + Commit Mono ramp") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                ForEach(ramp, id: \.0) { name, style in
                    HStack(alignment: .firstTextBaseline, spacing: OrpheusSpacing.md) {
                        Text(name)
                            .orpheusFont(OrpheusTypography.caption)
                            .orpheusForeground(OrpheusColor.Text.tertiary)
                            .frame(width: 60, alignment: .trailing)

                        Text("The quick brown fox")
                            .orpheusFont(style)
                            .orpheusForeground(OrpheusColor.Text.primary)

                        Text("\(Int(style.size))pt · \(Int(style.lineHeight))lh")
                            .orpheusFont(OrpheusTypography.caption)
                            .orpheusForeground(OrpheusColor.Text.disabled)
                    }
                }
            }
        }
    }
}

// MARK: - 3. Spacing

struct SpacingSection: View {
    private let steps: [(String, CGFloat)] = [
        ("step0 (0pt)",   OrpheusSpacing.step0),
        ("step1 (4pt)",   OrpheusSpacing.step1),
        ("step2 (8pt)",   OrpheusSpacing.step2),
        ("step3 (12pt)",  OrpheusSpacing.step3),
        ("step4 (16pt)",  OrpheusSpacing.step4),
        ("step5 (24pt)",  OrpheusSpacing.step5),
        ("step6 (32pt)",  OrpheusSpacing.step6),
        ("step7 (48pt)",  OrpheusSpacing.step7),
        ("step8 (64pt)",  OrpheusSpacing.step8),
    ]

    var body: some View {
        CatalogSection(title: "Spacing", subtitle: "4-pt grid — step0 through step8") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                ForEach(steps, id: \.0) { label, value in
                    HStack(alignment: .center, spacing: OrpheusSpacing.sm) {
                        Text(label)
                            .orpheusFont(OrpheusTypography.caption)
                            .orpheusForeground(OrpheusColor.Text.tertiary)
                            .frame(width: 100, alignment: .trailing)

                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(OrpheusColor.Accent.subtle.resolved)
                            .frame(width: max(value, 2), height: 8)
                    }
                }
            }
        }
    }
}

// MARK: - 4. Radius

struct RadiusSection: View {
    private let radii: [(String, CGFloat)] = [
        ("none (0)",   OrpheusRadius.none),
        ("chip (4)",   OrpheusRadius.chip),
        ("button (6)", OrpheusRadius.button),
        ("card (8)",   OrpheusRadius.card),
        ("modal (12)", OrpheusRadius.modal),
    ]

    var body: some View {
        CatalogSection(title: "Radius", subtitle: "Corner radius scale") {
            HStack(alignment: .center, spacing: OrpheusSpacing.lg) {
                ForEach(radii, id: \.0) { label, radius in
                    VStack(spacing: OrpheusSpacing.xs) {
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .fill(OrpheusColor.Accent.subtle.resolved)
                            .overlay(
                                RoundedRectangle(cornerRadius: radius, style: .continuous)
                                    .strokeBorder(OrpheusColor.Accent.primary.resolved, lineWidth: 1)
                            )
                            .frame(width: 40, height: 40)
                        Text(label)
                            .orpheusFont(OrpheusTypography.caption)
                            .orpheusForeground(OrpheusColor.Text.tertiary)
                    }
                }

                // Pill demo — use a fixed-height rect and clamp to half
                VStack(spacing: OrpheusSpacing.xs) {
                    Capsule(style: .continuous)
                        .fill(OrpheusColor.Accent.subtle.resolved)
                        .overlay(
                            Capsule(style: .continuous)
                                .strokeBorder(OrpheusColor.Accent.primary.resolved, lineWidth: 1)
                        )
                        .frame(width: 64, height: 24)
                    Text("pill")
                        .orpheusFont(OrpheusTypography.caption)
                        .orpheusForeground(OrpheusColor.Text.tertiary)
                }
            }
        }
    }
}

// MARK: - 5. Motion

struct MotionSection: View {
    private struct PresetRow: View {
        let name: String
        let preset: OrpheusMotion.SpringPreset
        @State private var isShifted = false

        var body: some View {
            HStack(spacing: OrpheusSpacing.md) {
                Text(name)
                    .orpheusFont(OrpheusTypography.caption)
                    .orpheusForeground(OrpheusColor.Text.tertiary)
                    .frame(width: 72, alignment: .leading)

                Text("response \(String(format: "%.2f", preset.response))  damping \(String(format: "%.2f", preset.dampingFraction))")
                    .orpheusFont(OrpheusTypography.mono)
                    .orpheusForeground(OrpheusColor.Text.secondary)
                    .frame(width: 220, alignment: .leading)

                // Spring preview ball
                ZStack(alignment: isShifted ? .trailing : .leading) {
                    RoundedRectangle(cornerRadius: OrpheusRadius.pill, style: .continuous)
                        .fill(OrpheusColor.Surface.elevated.resolved)
                        .frame(width: 80, height: 20)
                    Circle()
                        .fill(OrpheusColor.Accent.primary.resolved)
                        .frame(width: 16, height: 16)
                        .padding(.horizontal, 2)
                        .animation(preset.animation, value: isShifted)
                }
                .frame(width: 80)
                .contentShape(Rectangle())
                .onTapGesture {
                    isShifted.toggle()
                }
            }
        }
    }

    var body: some View {
        CatalogSection(title: "Motion", subtitle: "Spring presets — tap a row to preview") {
            VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
                PresetRow(name: "quick",    preset: OrpheusMotion.quick)
                PresetRow(name: "standard", preset: OrpheusMotion.standard)
                PresetRow(name: "settle",   preset: OrpheusMotion.settle)
                PresetRow(name: "dramatic", preset: OrpheusMotion.dramatic)
            }
        }
    }
}

// MARK: - 6. Materials

struct MaterialsSection: View {
    private let gradient = LinearGradient(
        colors: [OrpheusColor.Accent.primary.resolved, OrpheusColor.Semantic.info.resolved],
        startPoint: .leading,
        endPoint: .trailing
    )

    var body: some View {
        CatalogSection(title: "Materials", subtitle: "Blur · tint · saturation · rim") {
            HStack(spacing: OrpheusSpacing.md) {
                ForEach(OrpheusMaterial.all, id: \.name) { spec in
                    ZStack {
                        gradient
                            .frame(width: 200, height: 80)
                            .orpheusCornerRadius(OrpheusRadius.card)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(spec.name)
                                .orpheusFont(OrpheusTypography.caption)
                                .orpheusForeground(OrpheusColor.Text.primary)
                            Text("blur \(Int(spec.blurRadius))pt")
                                .orpheusFont(OrpheusTypography.caption)
                                .orpheusForeground(OrpheusColor.Text.secondary)
                            Text("sat \(String(format: "%.0f", spec.saturationBoost * 100))%")
                                .orpheusFont(OrpheusTypography.caption)
                                .orpheusForeground(OrpheusColor.Text.secondary)
                            Text(rimLabel(spec.rim))
                                .orpheusFont(OrpheusTypography.caption)
                                .orpheusForeground(OrpheusColor.Text.tertiary)
                        }
                        .padding(OrpheusSpacing.xs)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .orpheusMaterial(spec)
                        .orpheusCornerRadius(OrpheusRadius.card)
                    }
                    .frame(width: 200, height: 80)
                }
            }
        }
    }

    private func rimLabel(_ rim: OrpheusMaterial.Rim) -> String {
        switch rim {
        case .none:               return "rim: none"
        case .full(let w):        return "rim: full \(Int(w))pt"
        case .bottomEdge(let w):  return "rim: bottom \(Int(w))pt"
        }
    }
}

// MARK: - 7. Icons

struct IconsSection: View {
    private typealias Slot = (String, OrpheusIcon)
    private var slots: [Slot] {
        [
            ("project",       OrpheusIconSlot.project()),
            ("space",         OrpheusIconSlot.space()),
            ("terminal",      OrpheusIconSlot.terminal()),
            ("fork",          OrpheusIconSlot.fork()),
            ("selfDrive",     OrpheusIconSlot.selfDrive()),
            ("search",        OrpheusIconSlot.search()),
            ("chevronOpen",   OrpheusIconSlot.chevronOpen()),
            ("chevronClosed", OrpheusIconSlot.chevronClosed()),
            ("check",         OrpheusIconSlot.check()),
            ("close",         OrpheusIconSlot.close()),
            ("warning",       OrpheusIconSlot.warning()),
            ("critical",      OrpheusIconSlot.critical()),
            ("success",       OrpheusIconSlot.success()),
            ("info",          OrpheusIconSlot.info()),
        ]
    }

    var body: some View {
        CatalogSection(title: "Icons", subtitle: "OrpheusIconSlot named slots") {
            let columns = [
                GridItem(.fixed(80)),
                GridItem(.fixed(80)),
                GridItem(.fixed(80)),
                GridItem(.fixed(80)),
            ]
            LazyVGrid(columns: columns, alignment: .leading, spacing: OrpheusSpacing.md) {
                ForEach(slots, id: \.0) { name, icon in
                    VStack(spacing: OrpheusSpacing.xxs) {
                        icon
                        Text(name)
                            .orpheusFont(OrpheusTypography.caption)
                            .orpheusForeground(OrpheusColor.Text.tertiary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(width: 80)
                }
            }
        }
    }
}
