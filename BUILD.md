# Building Translator for Safari

Safari extensions ship inside a small macOS app. Apple's `safari-web-extension-converter` (part of Xcode) wraps the
`extension/` folder in that app, and `tools/mac-build.sh` does the whole build and install.

## What you need

```sh
xcode-select -p                                 # /Applications/Xcode.app/Contents/Developer (full Xcode, not only the command line tools)
security find-identity -v -p codesigning        # an "Apple Development: …" identity, for a signed build
/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" /Applications/Safari.app/Contents/Info.plist   # 26 or newer
```

- **Xcode**: free from the App Store. After installing: `sudo xcode-select -s /Applications/Xcode.app`.
- **Safari 26 or newer**: earlier versions block the WebAssembly the engine needs in an extension.
- **A signing certificate (optional)**: a free Apple ID is enough, no paid developer account. In Xcode › Settings ›
  Accounts add your Apple ID, then Manage Certificates… › **+** › **Apple Development**. Without one, build with
  `--unsigned` (see below).

## Try it without building (Safari 18.4+)

Safari can load the extension folder directly, until it quits or for 24 hours:

1. Safari › Settings › Advanced › tick **Show features for web developers**.
2. Safari › Settings › **Developer** › **Add Temporary Extension…** › choose the repository's `extension` folder.
3. Safari › Settings › Extensions › tick **Translator for Safari** and allow it on websites.

## Build and install

```sh
git clone https://github.com/pennico/safari-translator.git
cd safari-translator
tools/mac-build.sh
```

The script:

1. converts `extension/` to an Xcode project in `build/mac/` (git-ignored; the project references `extension/`,
   it doesn't copy it),
2. builds it in Release, signed with the keychain's Apple Development identity (manual signing, team read from the
   certificate; no provisioning profile is needed, the app only has the sandbox entitlements),
3. checks the result: build succeeded, bundle ids right, signature valid,
4. copies **Translator for Safari.app** to `~/Applications`, opens it once (that registers the extension with
   Safari) and lists it with `pluginkit`.

Options:

| | |
|---|---|
| `--no-install` | only build; the app stays in `build/mac/DerivedData/Build/Products/Release/` |
| `--unsigned` | no certificate: an ad hoc signature (see below) |
| `BUNDLE_ID=com.example.translator tools/mac-build.sh` | your own bundle id (default `dk.pennico.safari-translator`); the extension gets `<id>.Extension` |

If the build fails, the full log is `build/mac/xcodebuild.log`. Converter warnings about manifest keys Safari doesn't
use (`service_worker`, `preferred_environment`, `open_in_tab`, `browser_specific_settings`) are expected: the same
manifest also loads in Chromium for the tests.

## Turn it on in Safari

1. Safari › Settings › **Extensions** › tick **Translator for Safari**.
2. In the same pane: **Edit Websites…** › "Other websites" › **Allow** (or "Always Allow on Every Website" when
   Safari asks on the first page). That is needed for "Always translate this site" and for right-click translation
   anywhere. Allowing site by site works too; the toolbar button then still works on other sites, because clicking
   it grants that tab.
3. If the button isn't in the toolbar: View › Customize Toolbar… and drag it in.
4. Keyboard shortcut: ⇧⌘Y. macOS also uses ⇧⌘Y for the Stickies "Make Sticky Note" service; if that one wins, pick
   another shortcut in Safari › Settings › Extensions › Translator for Safari.

**Not listed, or listed as unsigned?** Turn on Safari › Settings › Advanced › **Show features for web developers**,
then Safari › Settings › Developer › **Allow unsigned extensions**. An `--unsigned` build always needs this, and Safari
turns it off every time it quits, so a signed build is more convenient.

## Update, uninstall

- **Update**: `git pull`, then `tools/mac-build.sh` again. The same bundle id keeps your settings and downloaded
  models. Older copies with the same bundle id in `~/Applications` (0.1.0 was called `Translator.app`) are removed.
- **Uninstall**: untick it in Safari › Settings › Extensions, then delete `~/Applications/Translator for Safari.app`.
  To free the models' disk space first, delete them on the Languages page.

## When something doesn't work

- **Engine**: Safari › Develop › **Web Extension Background Content** › Translator for Safari opens the background's
  Web Inspector. After the first translation its console shows `[engine] engine ready in … ms` and
  `model da-en loaded in … ms`. `engineHost.kind` says where the engine runs: `"worker"` (a Worker of the background
  page, the normal case) or `"page"` (Safari refused the Worker; the background page runs it itself).
- **Page side**: the page's Web Inspector, lines starting with `[translator]`.
- **Models**: the Languages page shows sizes and incomplete downloads, and can delete and re-download a model.

More in [DEVELOPMENT.md](DEVELOPMENT.md).
