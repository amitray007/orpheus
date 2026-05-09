import XCTest
@testable import OrpheusDesign

final class SpacingTests: XCTestCase {

    func testStepValuesMatchSpec() {
        XCTAssertEqual(OrpheusSpacing.step0, 0)
        XCTAssertEqual(OrpheusSpacing.step1, 4)
        XCTAssertEqual(OrpheusSpacing.step2, 8)
        XCTAssertEqual(OrpheusSpacing.step3, 12)
        XCTAssertEqual(OrpheusSpacing.step4, 16)
        XCTAssertEqual(OrpheusSpacing.step5, 24)
        XCTAssertEqual(OrpheusSpacing.step6, 32)
        XCTAssertEqual(OrpheusSpacing.step7, 48)
        XCTAssertEqual(OrpheusSpacing.step8, 64)
    }

    func testSemanticAliasesMatchSteps() {
        XCTAssertEqual(OrpheusSpacing.none,  OrpheusSpacing.step0)
        XCTAssertEqual(OrpheusSpacing.xxs,   OrpheusSpacing.step1)
        XCTAssertEqual(OrpheusSpacing.xs,    OrpheusSpacing.step2)
        XCTAssertEqual(OrpheusSpacing.sm,    OrpheusSpacing.step3)
        XCTAssertEqual(OrpheusSpacing.md,    OrpheusSpacing.step4)
        XCTAssertEqual(OrpheusSpacing.lg,    OrpheusSpacing.step5)
        XCTAssertEqual(OrpheusSpacing.xl,    OrpheusSpacing.step6)
        XCTAssertEqual(OrpheusSpacing.xxl,   OrpheusSpacing.step7)
        XCTAssertEqual(OrpheusSpacing.huge,  OrpheusSpacing.step8)
    }

    /// Every step is a multiple of the 4-px base unit.
    func testStepsRespect4pxGrid() {
        for step in OrpheusSpacing.all {
            XCTAssertEqual(
                step.truncatingRemainder(dividingBy: 4), 0,
                "Spacing step \(step) is not a multiple of 4"
            )
        }
    }

    /// Steps are strictly increasing — used by tooling that wants to
    /// pick the next step up from a given value.
    func testStepsAreMonotonic() {
        for (a, b) in zip(OrpheusSpacing.all, OrpheusSpacing.all.dropFirst()) {
            XCTAssertLessThan(a, b)
        }
    }
}
