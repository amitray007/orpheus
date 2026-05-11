{
  "targets": [
    {
      "target_name": "ghostty_native",
      "sources": ["addon.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../../vendor/GhosttyKit.xcframework/macos-arm64_x86_64/Headers"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-fobjc-arc"],
        "OTHER_LDFLAGS": []
      },
      "link_settings": {
        "libraries": [
          "<!(echo $(cd ../../ && pwd)/vendor/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a)",
          "-framework Carbon",
          "-framework Metal",
          "-framework MetalKit",
          "-framework AppKit",
          "-framework CoreText",
          "-framework QuartzCore",
          "-framework IOKit",
          "-framework Foundation",
          "-framework CoreFoundation",
          "-framework CoreGraphics",
          "-framework CoreServices",
          "-framework CoreImage",
          "-framework ImageIO",
          "-framework UniformTypeIdentifiers",
          "-framework CoreVideo"
        ]
      }
    }
  ]
}
