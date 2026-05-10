// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "OrpheusTerminal",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "OrpheusTerminal",
            targets: ["OrpheusTerminal"]
        ),
        .executable(
            name: "OrpheusTerminalSmoke",
            targets: ["OrpheusTerminalSmoke"]
        )
    ],
    dependencies: [
        .package(
            url: "https://github.com/Lakr233/libghostty-spm",
            exact: "1.0.1777879537"
        ),
        .package(
            name: "OrpheusDesign",
            path: "../OrpheusDesign"
        )
    ],
    targets: [
        .target(
            name: "OrpheusTerminal",
            dependencies: [
                .product(name: "GhosttyKit", package: "libghostty-spm"),
                .product(name: "GhosttyTerminal", package: "libghostty-spm"),
                .product(name: "OrpheusDesign", package: "OrpheusDesign")
            ]
        ),
        .executableTarget(
            name: "OrpheusTerminalSmoke",
            dependencies: ["OrpheusTerminal"]
        ),
        .testTarget(
            name: "OrpheusTerminalTests",
            dependencies: ["OrpheusTerminal"]
        ),
        .testTarget(
            name: "DisciplineLintTests",
            dependencies: []
        )
    ]
)
