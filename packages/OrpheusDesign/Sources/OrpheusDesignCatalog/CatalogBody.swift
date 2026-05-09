import SwiftUI
import OrpheusDesign

// MARK: - Section scaffold

struct CatalogSection<Content: View>: View {
    let title: String
    let subtitle: String?
    @ViewBuilder let content: () -> Content

    init(
        title: String,
        subtitle: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .orpheusFont(OrpheusTypography.heading)
                    .orpheusForeground(OrpheusColor.Text.primary)
                if let subtitle {
                    Text(subtitle)
                        .orpheusFont(OrpheusTypography.caption)
                        .orpheusForeground(OrpheusColor.Text.tertiary)
                }
            }
            content()
                .padding(OrpheusSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .orpheusBackground(OrpheusColor.Surface.raised)
                .orpheusCornerRadius(OrpheusRadius.card)
        }
    }
}

// MARK: - CatalogBody

struct CatalogBody: View {
    var body: some View {
        VStack(alignment: .leading, spacing: OrpheusSpacing.xl) {
            // ── Tokens ──────────────────────────────────────────────────────────
            Text("Tokens")
                .orpheusFont(OrpheusTypography.title)
                .orpheusForeground(OrpheusColor.Text.primary)

            TokensSection()

            // ── Components ──────────────────────────────────────────────────────
            Text("Components")
                .orpheusFont(OrpheusTypography.title)
                .orpheusForeground(OrpheusColor.Text.primary)

            ComponentsSection()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Group heading helper

struct CatalogGroupHeading: View {
    let title: String
    var body: some View {
        Text(title)
            .orpheusFont(OrpheusTypography.title)
            .orpheusForeground(OrpheusColor.Text.primary)
            .padding(.top, OrpheusSpacing.xs)
    }
}
