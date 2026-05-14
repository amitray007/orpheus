use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Only link libghostty on macOS.
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        // Walk up: src-tauri -> tauri-app -> orpheus -> vendor/...
        let vendor_dir = manifest_dir
            .parent() // tauri-app
            .unwrap()
            .parent() // orpheus
            .unwrap()
            .join("vendor/GhosttyKit.xcframework/macos-arm64_x86_64");

        let lib_dir = vendor_dir.join("Headers");
        let header = lib_dir.join("ghostty.h");

        println!("cargo:rustc-link-search=native={}", vendor_dir.display());
        println!("cargo:rustc-link-lib=static=ghostty");

        for fw in [
            "Carbon",
            "Metal",
            "MetalKit",
            "AppKit",
            "CoreText",
            "QuartzCore",
            "IOKit",
            "IOSurface",
            "Foundation",
            "CoreFoundation",
            "CoreGraphics",
            "CoreServices",
            "CoreImage",
            "ImageIO",
            "UniformTypeIdentifiers",
            "CoreVideo",
        ] {
            println!("cargo:rustc-link-lib=framework={fw}");
        }

        // C++ runtime — libghostty includes simdutf and other C++ code.
        println!("cargo:rustc-link-lib=c++");
        // libresolv for DNS, iconv for character encoding.
        println!("cargo:rustc-link-lib=dylib=resolv");
        println!("cargo:rustc-link-lib=dylib=iconv");

        // Add SDK system lib dir so the linker resolves libdispatch (part of libSystem).
        let sdk_path = std::process::Command::new("xcrun")
            .args(["--show-sdk-path"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        let sdk_path = sdk_path.trim();
        if !sdk_path.is_empty() {
            println!("cargo:rustc-link-search=native={sdk_path}/usr/lib/system");
            // dispatch is a re-export of libSystem; resolved via the TBD stub above.
            println!("cargo:rustc-link-lib=dylib=dispatch");
        }

        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        let bindings = bindgen::Builder::default()
            .header(header.to_str().unwrap())
            .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
            .allowlist_type("ghostty_.*")
            .allowlist_function("ghostty_.*")
            .allowlist_var("GHOSTTY_.*")
            .generate()
            .expect("bindgen failed on ghostty.h");

        bindings
            .write_to_file(out_dir.join("ghostty_bindings.rs"))
            .expect("write ghostty_bindings.rs");
    }
}
