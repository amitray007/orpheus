cask "orpheus-nightly" do
  version "{{VERSION}}"
  sha256 "{{SHA256}}"

  url "https://github.com/amitray007/homebrew-tap/releases/download/orpheus-nightly-v#{version}/orpheus-nightly-#{version}.dmg",
      verified: "github.com/amitray007/homebrew-tap/"
  name "Orpheus Nightly"
  desc "Mac IDE built around Claude Code (nightly channel)"
  homepage "https://github.com/amitray007/orpheus"

  # Nightly is a separate app from the stable `orpheus` cask: its own bundle id
  # (dev.orpheus.nightly) and its own data dir (~/Library/Application Support/
  # Orpheus Nightly), so installing it never touches a stable install or its
  # sqlite database. The two are intended to coexist.
  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Orpheus Nightly.app"

  # Symlinks the in-bundle CLI shim onto PATH as `orpheus-nightly` (target:
  # renames the link so it doesn't collide with the stable cask's `orpheus`
  # link — both casks can be installed side by side). brew manages the link:
  # created on install, re-pointed on upgrade, removed on uninstall — no
  # privilege prompt. The shim itself needs no per-variant logic: it resolves
  # ORPHEUS_INVOKED_VARIANT from which Electron binary sits next to it inside
  # THIS bundle, regardless of what the symlink is named (see
  # resources/bin/orpheus's header comment). Path must match
  # electron-builder-nightly.yml's extraResources mapping for
  # resources/bin/orpheus -> Contents/Resources/bin/orpheus; if that mapping
  # ever moves, update this line too or the symlink dangles.
  binary "#{appdir}/Orpheus Nightly.app/Contents/Resources/bin/orpheus", target: "orpheus-nightly"

  # Strip quarantine + re-sign ad-hoc after install so macOS 15+ accepts the bundle.
  # electron-builder leaves inner frameworks with mismatched Team IDs;
  # a unified ad-hoc re-sign normalises them.
  postflight do
    system_command "/usr/bin/xattr",
                   args: ["-dr", "com.apple.quarantine", "#{appdir}/Orpheus Nightly.app"],
                   sudo: false
    system_command "/usr/bin/codesign",
                   args: ["--force", "--deep", "--sign", "-", "#{appdir}/Orpheus Nightly.app"],
                   sudo: false
  end

  zap trash: [
    "~/Library/Application Support/Orpheus Nightly",
    "~/Library/Preferences/dev.orpheus.nightly.plist",
    "~/Library/Logs/Orpheus Nightly",
    "~/Library/Caches/dev.orpheus.nightly",
    "~/Library/Saved Application State/dev.orpheus.nightly.savedState",
  ]
end
