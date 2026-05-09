// OrpheusDesign — Phase 0 design-system foundation.
//
// Public surface mirrors the structure documented in
// extras/specs/design-principles.md and extras/specs/architecture.md
// of the planning repo. Every module that renders UI in Orpheus imports
// this package and uses its tokens + components — never stock SwiftUI
// controls. See README.md (Discipline rules) for the binding constraints.

import Foundation

public enum OrpheusDesign {
    /// Semantic version of the design-system surface. Bump when token
    /// values or component APIs change in a way feature phases need to
    /// notice.
    public static let version = "0.1.0"
}
