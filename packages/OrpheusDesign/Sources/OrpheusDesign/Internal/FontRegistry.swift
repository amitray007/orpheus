import AppKit
import CoreText
import Foundation

/// Tiny per-package font loader.
///
/// On first access we walk `Sources/OrpheusDesign/Resources/Fonts/` (whatever
/// the bundle resolves to at runtime), register every `.otf` / `.ttf` we
/// find with `CTFontManagerRegisterFontsForURL`, and remember which family
/// names ended up registered. Components query the registry to decide
/// whether the branded face is available and fall back to a system face if
/// not.
///
/// The package ships **without font binaries** in v0 — Satoshi licensing
/// must be confirmed before commit, and Commit Mono is OFL but not yet
/// downloaded. Drop the files into `Resources/Fonts/` and they'll be
/// picked up automatically; nothing else changes.
final class FontRegistry: @unchecked Sendable {

    static let shared = FontRegistry()

    private let knownFamilies: Set<String>
    private let registeredPostScriptNames: Set<String>

    private init() {
        var families: Set<String> = []
        var postScript: Set<String> = []

        let fontsURL = Bundle.module.bundleURL.appendingPathComponent("Fonts", isDirectory: true)
        let fileManager = FileManager.default

        if let urls = try? fileManager.contentsOfDirectory(
            at: fontsURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) {
            for url in urls where Self.isFontFile(url) {
                var error: Unmanaged<CFError>?
                if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                    if let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] {
                        for descriptor in descriptors {
                            if let family = CTFontDescriptorCopyAttribute(descriptor, kCTFontFamilyNameAttribute) as? String {
                                families.insert(family)
                            }
                            if let name = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String {
                                postScript.insert(name)
                            }
                        }
                    }
                }
                // Errors are intentionally swallowed — package builds and
                // catalog runs whether or not the branded face is around.
                error?.release()
            }
        }

        self.knownFamilies = families
        self.registeredPostScriptNames = postScript
    }

    /// `true` when any face within the given family was successfully
    /// registered (or was already present on the system, since
    /// `NSFontManager` answers across all sources).
    func isFamilyAvailable(_ name: String) -> Bool {
        if knownFamilies.contains(name) { return true }
        return NSFontManager.shared.availableFontFamilies.contains(name)
    }

    /// `true` when a specific PostScript name is resolvable. Stricter than
    /// `isFamilyAvailable` — useful when the caller wants a particular
    /// weight/style.
    func isPostScriptNameAvailable(_ name: String) -> Bool {
        if registeredPostScriptNames.contains(name) { return true }
        return NSFont(name: name, size: 12) != nil
    }

    private static func isFontFile(_ url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        return ext == "otf" || ext == "ttf" || ext == "ttc"
    }
}
