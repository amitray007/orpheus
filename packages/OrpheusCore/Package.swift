// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OrpheusCore",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "OrpheusCore",
            targets: ["OrpheusCore"]
        ),
        .executable(
            name: "OrpheusCoreSmoke",
            targets: ["OrpheusCoreSmoke"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift", from: "6.0.0")
    ],
    targets: [
        .target(
            name: "OrpheusCore",
            dependencies: [
                .product(name: "GRDB", package: "GRDB.swift")
            ]
        ),
        .executableTarget(
            name: "OrpheusCoreSmoke",
            dependencies: ["OrpheusCore"]
        ),
        .testTarget(
            name: "OrpheusCoreTests",
            dependencies: [
                "OrpheusCore",
                .product(name: "GRDB", package: "GRDB.swift")
            ]
        ),
        .testTarget(
            name: "DisciplineLintTests",
            dependencies: []
        )
    ]
)
