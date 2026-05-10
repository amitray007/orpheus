{
  "targets": [
    {
      "target_name": "native_spike_zorder",
      "conditions": [
        ["OS == 'mac'", {
          "sources": ["addon.mm"],
          "cflags_cc": ["-fobjc-arc", "-std=c++17"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "OTHER_CPLUSPLUSFLAGS": ["-fobjc-arc", "-std=c++17"]
          },
          "link_settings": {
            "libraries": [
              "-framework Cocoa",
              "-framework QuartzCore"
            ]
          }
        }]
      ]
    }
  ]
}
