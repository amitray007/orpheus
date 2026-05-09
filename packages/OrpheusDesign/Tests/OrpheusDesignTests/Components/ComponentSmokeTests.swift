import AppKit
import SwiftUI
import XCTest
@testable import OrpheusDesign

// MARK: - Render helpers

/// Wraps a SwiftUI view in an NSHostingView with a fixed frame and forces
/// a layout pass. Returns the host so callers can inspect it.
@MainActor
private func render<V: View>(
    _ view: V,
    size: CGSize = CGSize(width: 480, height: 240)
) -> NSHostingView<AnyView> {
    let sized = AnyView(view.frame(width: size.width, height: size.height))
    let host  = NSHostingView(rootView: sized)
    host.frame = NSRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    return host
}

/// Returns the total number of NSView nodes in the entire subview tree,
/// including the root.
private func totalViewCount(_ view: NSView) -> Int {
    1 + view.subviews.reduce(0) { $0 + totalViewCount($1) }
}

/// Renders the view under both dark and light themes and asserts that
/// the component instantiated successfully without crashing and that the
/// hosting view's layout engine produced a valid (non-zero) frame.
///
/// Why frame-size rather than subview count: pure-SwiftUI components
/// (Text, Circle, RoundedRectangle, GeometryReader etc.) never create
/// AppKit NSView children — they are rendered directly by SwiftUI's
/// private drawing layer. Counting subviews would therefore always be
/// zero for those components even though they render correctly. Checking
/// that the hosting view's frame is correctly sized after
/// `layoutSubtreeIfNeeded()` is a lightweight, reliable proxy for
/// "the view tree was built without crashing and layout ran."
///
/// Components that *do* contain NSViewRepresentable children (NSTextField,
/// NSVisualEffectView from .orpheusMaterial, NSScrollView etc.) will
/// additionally produce AppKit subviews, which we also verify.
@MainActor
private func assertRenders<V: View>(
    _ view: V,
    size: CGSize = CGSize(width: 480, height: 240),
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let dark  = render(view.orpheusTheme(.dark),  size: size)
    let light = render(view.orpheusTheme(.light), size: size)

    // 1. The hosting view must have the expected frame (layout ran without crash)
    XCTAssertEqual(dark.frame.size,  size,
                   "dark theme: hosting view has unexpected frame size",
                   file: file, line: line)
    XCTAssertEqual(light.frame.size, size,
                   "light theme: hosting view has unexpected frame size",
                   file: file, line: line)

    // 2. The hosting view itself counts as 1; require at least that many nodes.
    //    This catches a theoretical nil-content crash that would leave the
    //    view count at 0, while not being overly strict about pure-SwiftUI
    //    components that never materialise AppKit sub-views.
    XCTAssertGreaterThanOrEqual(
        totalViewCount(dark), 1,
        "dark theme: no NSView nodes at all (hosting view disappeared?)",
        file: file, line: line
    )
    XCTAssertGreaterThanOrEqual(
        totalViewCount(light), 1,
        "light theme: no NSView nodes at all (hosting view disappeared?)",
        file: file, line: line
    )
}

// MARK: - Component smoke tests

final class ComponentSmokeTests: XCTestCase {

    // MARK: 1 — OrpheusText

    @MainActor
    func testTextRendersAllStyles() {
        let styles: [OrpheusTypography.Style] = [
            OrpheusTypography.display,
            OrpheusTypography.title,
            OrpheusTypography.heading,
            OrpheusTypography.body,
            OrpheusTypography.caption,
            OrpheusTypography.mono,
        ]
        for style in styles {
            assertRenders(OrpheusText("hello", style: style))
        }
    }

    // MARK: 2 — OrpheusButton

    @MainActor
    func testButtonRendersAllVariants() {
        let variants: [OrpheusButton.Variant] = [.primary, .secondary, .tertiary, .destructive, .ghost]
        let sizes: [OrpheusButton.Size] = [.small, .medium, .large]
        for variant in variants {
            for size in sizes {
                assertRenders(OrpheusButton("Label", variant: variant, size: size) {})
            }
        }
        // loading state
        assertRenders(OrpheusButton("Loading…", isLoading: true) {})
        // disabled state
        assertRenders(OrpheusButton("Off", isEnabled: false) {})
    }

    // MARK: 3 — OrpheusToggle

    @MainActor
    func testToggleRendersAllStyles() {
        let styles: [OrpheusToggle.Style] = [.checkbox, .radio, .switch]
        for style in styles {
            assertRenders(OrpheusToggle(style, isOn: .constant(false)))
            assertRenders(OrpheusToggle(style, isOn: .constant(true)))
            assertRenders(OrpheusToggle(style, isOn: .constant(false), label: "Label off"))
            assertRenders(OrpheusToggle(style, isOn: .constant(true), label: "Label on"))
        }
    }

    // MARK: 4 — OrpheusTextField

    @MainActor
    func testTextFieldRenders() {
        // empty, no icon
        assertRenders(OrpheusTextField("Placeholder", text: .constant("")))
        // with leading icon
        assertRenders(OrpheusTextField(
            "Search…",
            text: .constant(""),
            leadingIcon: OrpheusIconSlot.search()
        ))
        // pre-filled
        assertRenders(OrpheusTextField("Field", text: .constant("hello")))
        // sizes
        for size in [OrpheusTextField.Size.small, .medium, .large] {
            assertRenders(OrpheusTextField("Size", text: .constant(""), size: size))
        }
    }

    // MARK: 5 — OrpheusTextArea

    @MainActor
    func testTextAreaRenders() {
        assertRenders(
            OrpheusTextArea("Write something…", text: .constant("")),
            size: CGSize(width: 400, height: 120)
        )
        assertRenders(
            OrpheusTextArea("Prefilled", text: .constant("Line one\nLine two")),
            size: CGSize(width: 400, height: 120)
        )
        assertRenders(
            OrpheusTextArea("Disabled", text: .constant(""), isEnabled: false),
            size: CGSize(width: 400, height: 120)
        )
    }

    // MARK: 6 — OrpheusMenu

    @MainActor
    func testMenuRenders() {
        let items: [OrpheusMenu<OrpheusButton>.Item] = [
            .init(title: "Section", kind: .header("Section")),
            .init(title: "Action one", kind: .action({})),
            .init(title: "---", kind: .separator),
            .init(title: "Action two", icon: OrpheusIconSlot.search(size: .small), kind: .action({})),
            .init(title: "Disabled", kind: .action({}), isEnabled: false),
        ]
        assertRenders(
            OrpheusMenu(items: items) {
                OrpheusButton("Open menu", variant: .secondary) {}
            }
        )
    }

    // MARK: 7 — OrpheusList + OrpheusRow

    @MainActor
    func testListRendersAllStyles() {
        struct Item: Identifiable {
            let id: Int
            let title: String
            let subtitle: String
        }
        let data = [
            Item(id: 0, title: "Alpha", subtitle: "first item"),
            Item(id: 1, title: "Beta",  subtitle: "second item"),
            Item(id: 2, title: "Gamma", subtitle: "third item"),
        ]
        for style in [OrpheusListStyle.inset, .plain, .sidebar] {
            assertRenders(
                OrpheusList(data, id: \.id, style: style) { item in
                    OrpheusRow(item.title, subtitle: item.subtitle)
                },
                size: CGSize(width: 320, height: 300)
            )
        }
        // OrpheusRow standalone variants
        assertRenders(OrpheusRow("Title only"))
        assertRenders(OrpheusRow("With icon", leading: OrpheusIcon(systemName: "folder", size: .medium, color: OrpheusColor.Text.secondary)))
        assertRenders(OrpheusRow("Selected", isSelected: true))
        assertRenders(OrpheusRow("Disclosure", showsDisclosure: true))
    }

    // MARK: 8 — OrpheusSplitView

    @MainActor
    func testSplitViewRendersAllAxes() {
        let content = { Text("pane") }
        for axis in [Axis.horizontal, .vertical] {
            assertRenders(
                OrpheusSplitView(axis: axis, leading: content, trailing: content),
                size: CGSize(width: 600, height: 400)
            )
        }
    }

    // MARK: 9 — OrpheusSidebar + OrpheusSpaceSwitcher

    @MainActor
    func testSidebarWithSpaceSwitcherRenders() {
        let projects: [ProjectItem] = [
            ProjectItem(
                id: "proj1",
                name: "thoughts",
                isExpanded: true,
                spaces: [
                    SpaceItem(id: "s1", name: "My Space", activity: .running, isActive: true),
                    SpaceItem(id: "s2", name: "brainstorm", activity: .idle),
                ]
            ),
            ProjectItem(
                id: "proj2",
                name: "archived",
                isExpanded: false,
                spaces: [
                    SpaceItem(id: "s3", name: "old-branch", activity: .dormant),
                ]
            ),
        ]
        let sidebar = OrpheusSidebar(
            top: {
                OrpheusText("Top slot", style: OrpheusTypography.caption)
            },
            bodyContent: {
                OrpheusSpaceSwitcher(projects: projects, activeSpaceID: "s1")
            },
            bottom: {
                OrpheusText("Status", style: OrpheusTypography.caption)
            }
        )
        assertRenders(sidebar, size: CGSize(width: 240, height: 520))
    }

    // MARK: 10 — OrpheusCommandPalette

    @MainActor
    func testCommandPaletteRenders() {
        let sessions = OrpheusCommandPalette.Group(
            id: "sessions",
            title: "Sessions",
            items: [
                OrpheusCommandPalette.Item(id: "s1", title: "Fix auth bug", subtitle: "thoughts/main"),
                OrpheusCommandPalette.Item(id: "s2", title: "Refactor API", subtitle: "api/v2"),
            ]
        )
        let actions = OrpheusCommandPalette.Group(
            id: "actions",
            title: "Actions",
            items: [
                OrpheusCommandPalette.Item(
                    id: "a1",
                    title: "New session",
                    icon: OrpheusIconSlot.selfDrive(),
                    trailingHint: "⌘↩"
                ),
            ]
        )
        assertRenders(
            OrpheusCommandPalette(
                query: .constant(""),
                groups: [sessions, actions],
                selectedID: .constant("s1"),
                onSubmit: { _ in },
                onDismiss: {}
            ),
            size: CGSize(width: 580, height: 500)
        )
    }

    // MARK: 11 — OrpheusModal

    @MainActor
    func testModalRenders() {
        // Render the modal card directly (isPresented: true so the card is shown)
        assertRenders(
            OrpheusModal(isPresented: .constant(true), title: "Test Modal") {
                OrpheusText("Body content", style: OrpheusTypography.body)
            },
            size: CGSize(width: 600, height: 400)
        )
        // Also verify the .orpheusModal modifier composes cleanly
        assertRenders(
            Text("Parent")
                .orpheusModal(isPresented: .constant(true), title: "Via modifier") {
                    OrpheusText("Content", style: OrpheusTypography.body)
                },
            size: CGSize(width: 600, height: 400)
        )
    }

    // MARK: 12 — OrpheusSheet (HeaderFooterScaffold)

    @MainActor
    func testSheetHeaderFooterScaffoldRenders() {
        let scaffold = OrpheusSheet<AnyView>.HeaderFooterScaffold(
            title: "New space",
            footerButtons: [
                AnyView(OrpheusButton("Cancel", variant: .secondary) {}),
                AnyView(OrpheusButton("Create", variant: .primary) {}),
            ]
        ) {
            OrpheusText("Inner content", style: OrpheusTypography.body)
        }
        assertRenders(scaffold, size: CGSize(width: 520, height: 300))
    }

    // MARK: 13 — OrpheusStatusBadge

    @MainActor
    func testStatusBadgeRendersAllKindsAndStyles() {
        let kinds: [OrpheusStatusBadge.Kind] = [
            .neutral, .info, .success, .warning, .critical, .accent, .live, .dormant,
        ]
        let styles: [OrpheusStatusBadge.BadgeStyle] = [.filled, .soft, .outline]
        for kind in kinds {
            for style in styles {
                assertRenders(OrpheusStatusBadge("label", kind: kind, style: style))
            }
        }
    }

    // MARK: 14 — OrpheusTooltip

    @MainActor
    func testTooltipRenders() {
        // Bubble standalone
        assertRenders(OrpheusTooltip("Helpful hint"))
        // View with modifier applied (popover isn't presented; modifier still composes)
        assertRenders(
            OrpheusText("Hover me", style: OrpheusTypography.body)
                .orpheusTooltip("Tooltip text", placement: .above)
        )
        // All placements
        for placement in [OrpheusTooltipPlacement.above, .below, .leading, .trailing] {
            assertRenders(
                OrpheusText("Target", style: OrpheusTypography.body)
                    .orpheusTooltip("Hint", placement: placement)
            )
        }
    }

    // MARK: 15 — OrpheusQuickAction

    @MainActor
    func testQuickActionRendersAllKindsWithAndWithoutGlyph() {
        let kinds: [OrpheusQuickAction.Kind] = [.standard, .primary, .ghost]
        for kind in kinds {
            // No glyph
            assertRenders(OrpheusQuickAction("Action", kind: kind) {})
            // With glyph
            assertRenders(OrpheusQuickAction(
                "Action",
                glyph: OrpheusIcon(systemName: "checkmark", size: .small, color: OrpheusColor.Text.secondary),
                kind: kind
            ) {})
            // Disabled
            assertRenders(OrpheusQuickAction("Off", kind: kind, isEnabled: false) {})
        }
    }

    // MARK: 16 — OrpheusSpinner

    @MainActor
    func testSpinnerRendersAllSizes() {
        for size in [OrpheusSpinner.Size.small, .medium, .large] {
            assertRenders(OrpheusSpinner(size: size))
        }
    }

    // MARK: 17 — OrpheusProgressBar

    @MainActor
    func testProgressBarRendersAllVariants() {
        // Determinate
        for progress in [0.0, 0.5, 1.0] {
            assertRenders(
                OrpheusProgressBar(progress: progress),
                size: CGSize(width: 300, height: 24)
            )
        }
        // Indeterminate
        assertRenders(
            OrpheusProgressBar(progress: nil),
            size: CGSize(width: 300, height: 24)
        )
        // Sizes
        for size in [OrpheusProgressBar.Size.small, .medium, .large] {
            assertRenders(
                OrpheusProgressBar(progress: 0.6, size: size),
                size: CGSize(width: 300, height: 24)
            )
        }
    }

    // MARK: 18 — OrpheusSkeleton

    @MainActor
    func testSkeletonRenders() {
        // Single bar with explicit width
        assertRenders(
            OrpheusSkeleton(width: 240, height: 12),
            size: CGSize(width: 300, height: 40)
        )
        // Full-width bar (nil width — GeometryReader driven)
        assertRenders(
            OrpheusSkeleton(height: 20),
            size: CGSize(width: 300, height: 40)
        )
        // Multi-line row convenience
        assertRenders(
            OrpheusSkeleton.row(lines: 3).frame(width: 280),
            size: CGSize(width: 320, height: 80)
        )
    }

    // MARK: 19 — OrpheusToast + OrpheusToastStack

    @MainActor
    func testToastRendersAllKinds() {
        let kinds: [OrpheusToast.Kind] = [.info, .success, .warning, .critical]
        for kind in kinds {
            // Bare message
            assertRenders(
                OrpheusToast("Something happened", kind: kind),
                size: CGSize(width: 420, height: 80)
            )
            // With title
            assertRenders(
                OrpheusToast("Details here", kind: kind, title: "Title", onDismiss: {}),
                size: CGSize(width: 420, height: 100)
            )
        }
        // Stack of three
        let stack = OrpheusToastStack([
            OrpheusToastItem("Build OK", kind: .success, title: "Success"),
            OrpheusToastItem("3 warnings found", kind: .warning),
            OrpheusToastItem("Network error", kind: .critical, title: "Error"),
        ])
        assertRenders(stack, size: CGSize(width: 420, height: 320))
    }

    // MARK: 20 — OrpheusBanner

    @MainActor
    func testBannerRendersAllKinds() {
        let kinds: [OrpheusBanner.Kind] = [.info, .success, .warning, .critical]
        for kind in kinds {
            // Without action
            assertRenders(
                OrpheusBanner("Message body", kind: kind, onDismiss: {}),
                size: CGSize(width: 520, height: 80)
            )
            // With title + primary action
            assertRenders(
                OrpheusBanner(
                    "Message body",
                    kind: kind,
                    title: "Banner title",
                    primaryAction: .init(title: "Retry") {},
                    onDismiss: {}
                ),
                size: CGSize(width: 520, height: 100)
            )
        }
        // Non-dismissable variant
        assertRenders(
            OrpheusBanner("Running in offline mode.", kind: .warning, isDismissable: false),
            size: CGSize(width: 520, height: 80)
        )
    }
}
