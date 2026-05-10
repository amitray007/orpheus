import Foundation
import GhosttyTerminal

/// Translate an `OrpheusTerminalPalette` into a `TerminalConfiguration`
/// suitable for injecting into a `TerminalController`.
///
/// We use the `TerminalConfiguration` DSL rather than raw `ghostty_config_t`
/// calls because `GhosttyTerminal` owns the config lifecycle.
func makeConfiguration(for palette: TerminalPalette) -> TerminalConfiguration {
    TerminalConfiguration { builder in
        builder.withBackground(palette.background.hexString)
        builder.withForeground(palette.foreground.hexString)
        builder.withCursorColor(palette.cursor.hexString)
        builder.withSelectionBackground(palette.selection.hexString)

        for (index, color) in palette.ansi.colors.enumerated() {
            builder.withPalette(index, color: color.hexString)
        }

        // Orpheus defaults
        builder.withCursorStyle(.block)
        builder.withCursorStyleBlink(true)
        builder.withFontSize(14)
        builder.withWindowPaddingX(4)
        builder.withWindowPaddingY(4)
    }
}
