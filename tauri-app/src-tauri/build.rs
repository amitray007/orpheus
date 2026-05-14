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

        // Also link libresolv which ghostty needs for DNS.
        println!("cargo:rustc-link-lib=dylib=resolv");
        println!("cargo:rustc-link-lib=dylib=iconv");

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
