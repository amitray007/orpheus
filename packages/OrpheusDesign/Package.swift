// swift-tools-version: 5.9
// Phase 0 — design-system foundation. No external dependencies.

import PackageDescription

let package = Package(
    name: "OrpheusDesign",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "OrpheusDesign",
            targets: ["OrpheusDesign"]
        ),
        .executable(
            name: "OrpheusDesignCatalog",
            targets: ["OrpheusDesignCatalog"]
        )
    ],
    targets: [
        .target(
            name: "OrpheusDesign",
            resources: [
                .process("Resources")
            ]
        ),
        .executableTarget(
            name: "OrpheusDesignCatalog",
            dependencies: ["OrpheusDesign"]
        ),
        .testTarget(
            name: "OrpheusDesignTests",
            dependencies: ["OrpheusDesign"]
        )
    ]
)
