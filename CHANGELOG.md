# Changelog

## 0.2.0 — 2026-11-17
First public release.
- Renamed to **Translator for Safari** (app and extension). The bundle id stays `dk.pennico.safari-translator`, so an
  installed 0.1.0 keeps its settings and models; `tools/mac-build.sh` removes the old `Translator.app`.
- `tools/mac-build.sh`: `--unsigned` for builds without a certificate, `BUNDLE_ID=…` for your own id, stops unless
  the build succeeded and both bundle ids are right (Xcode 27's converter names the app after the app name).
- Licence: MPL-2.0. Public docs: README, BUILD.md, DEVELOPMENT.md; CI runs the unit and headless Chromium tests and
  a scan for private details.
- `jstest/setup.sh` works on macOS and on Linux with or without root.

## 0.1.0 — 2026-11-17
First version, built and used privately.
- Mozilla's offline engine (bergamot-translator 4.0 WASM + Firefox's glue) in the background (Safari: Worker of the
  background page; Chromium: service worker); fastText lid.176 language detection.
- Models from Mozilla's Remote Settings on first use, SHA-256 checked, unpacked, kept in IndexedDB; pivot through
  English for pairs without a direct model.
- Page translation: visible screen first, inline markup kept, in-place updates, exact restore, MutationObserver for
  new text, attributes and the title; skip code/pre/forms/editable/translate=no.
- Popup (from/to, Translate/Show original, Always translate this site, timings), ⇧⌘Y, right-click Translate
  Selection bubble with Copy, Languages page (settings, models on disk, downloads, speed check), status note.
- Tests: acceptance checks in headless Chromium, unit checks, speed (fixture and live page), engine in WebKit.
- Mac: tools/mac-build.sh (converter + xcodebuild, Apple Development signing).
