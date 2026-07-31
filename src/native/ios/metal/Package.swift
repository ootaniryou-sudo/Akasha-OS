// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "ArcAshaMetal",
  platforms: [
    .iOS(.v17),    // iOS 17+ for Metal 3 + A17 Pro features
    .macOS(.v14),  // macOS 14+ for MPSGraph
  ],
  products: [
    .library(
      name: "ArcAshaMetal",
      targets: ["ArcAshaMetal"]
    ),
  ],
  dependencies: [],
  targets: [
    .target(
      name: "ArcAshaMetal",
      dependencies: [],
      path: "Sources/ArcAshaMetal",
      resources: [
        .process("../Shaders")  // Metal shader files
      ]
    ),
    .testTarget(
      name: "ArcAshaMetalTests",
      dependencies: ["ArcAshaMetal"],
      path: "Tests/ArcAshaMetalTests"
    ),
  ]
)
