# Development

How the code is laid out, how to test it, and how to update the bundled engine. What it does and why: README.md.
Building the Safari app: BUILD.md.

## Layout

```
extension/            the Web Extension (load unpacked in Chromium; Apple's converter wraps it for Safari)
  manifest.json       MV3; background: Safari uses "scripts" (a background page), Chromium the service worker
  background/         engine host, messages, right-click menu, ⇧⌘Y, toolbar badge
  content/content.js  page walking, applying, Show original, MutationObserver, status note, selection bubble
  engine/             engine.js (models, Bergamot, fastText), worker.js, vendor/ (pinned third-party files)
  popup/ options/ ui/ shared/ icons/
tools/                mac-build.sh, fetch-engine.mjs (re-download + check vendor files), make-icons.mjs, *.svg
jstest/               headless tests: unit.mjs, test.mjs, speed.mjs, webkit-engine.mjs, shots.mjs
scripts/              scan-private.sh (CI: no private details in the tree)
```

No build step: the files in `extension/` are what Safari loads. JavaScript without a bundler or framework.

## Tests

The extension also loads unpacked in Chromium, so most of it is tested in headless Chromium with Playwright.

```sh
node tools/fetch-engine.mjs --check   # vendored engine files match their pinned SHA-256
cd jstest && ./setup.sh               # once: Playwright and Chromium (Linux without root: libraries into .libs)
node unit.mjs                         # engine-output parser and model-list rules, no browser
./run.sh test.mjs                     # acceptance checks in headless Chromium; exit 0 = all passed
./run.sh speed.mjs [--url https://…]  # speed on the test article or a live page
./run.sh shots.mjs                    # screenshots of popup, page, bubble, Languages page → out/
./run.sh webkit-engine.mjs            # the engine in WebKit (Safari's engine) next to Chromium
```

Things to know:

- Each test run uses a **fresh** Chromium profile: Chrome keeps an unpacked extension's old service-worker script
  in a reused profile, so edits silently wouldn't load.
- Mozilla's attachment CDN answers **HTTP 406 to Chrome user agents** (Safari's and Node's get 200). The tests
  therefore route the CDN through `jstest/.models`, filled by Node's `fetch` the first time. Don't spoof the
  browser's user agent instead. In Safari this doesn't arise.
- The content script's isolated world is reached through the DevTools protocol (`contentEval` in `lib.mjs`). The
  bubble and the note live in a closed shadow root; `__stTranslatorDebug` exists only in that world.
- `webkit-engine.mjs` runs Playwright's WebKit (WPE MiniBrowser). On a Linux host without root its many system
  libraries (gstreamer, gtk4, Mesa EGL, glib-networking …) have to be unpacked into `jstest/.libs` like setup.sh does
  for Chromium; `webkit-run.sh` then starts it with software EGL and only the GIO TLS module.
- Test pages are in `jstest/fixtures/` (Danish text written for the tests).

## Bundled engine files (extension/engine/vendor/)

- Pinned by SHA-256 in `tools/fetch-engine.mjs`. `node tools/fetch-engine.mjs` downloads them again from their
  sources; `--check` only verifies.
- `bergamot-translator.js` must match `bergamot-translator.wasm`. Firefox ships the glue in its source tree and the
  WASM through Remote Settings (`translations-wasm-v2`). Update both together: take the glue from the Firefox revision
  whose `TranslationsParent.BERGAMOT_MAJOR_VERSION` matches the new WASM record, keep the model major version
  (`ENGINE_CONST.MODEL_MAJOR` in engine.js) in step with Firefox's `LANGUAGE_MODEL_MAJOR_VERSION`, run all tests and
  record the change in THIRD-PARTY.md.
- The WASM must not need relaxed SIMD while Safari versions before 27.3 are supported (Mozilla builds with
  `-msimd128`).

## Safari specifics

- `background` lists both `service_worker` (Chromium) and `scripts` with `preferred_environment: ["document",
  "service_worker"]`: Safari 18+ then uses a background page, which can start a Worker for the engine. If Safari
  refuses the Worker, the background page loads the engine itself (`engineHost.kind` is `"page"`).
- Safari unloads an idle background after 30 seconds, even with a `sendMessage` reply pending. Long calls use a port
  (`engineLong` in shared/common.js) with progress messages, which keeps it alive.
- `wasm-unsafe-eval` in the extension CSP works from Safari 26, hence the minimum version.
- Context-menu items live in memory only: they are created again at every background start.
- `storage.local` is capped without `unlimitedStorage`; models live in IndexedDB.

## When something fails in Safari

- **Background console**: Safari › Develop › Web Extension Background Content › Translator for Safari. Lines
  `[engine] …`; `engineHost.kind`.
- **Page side**: the page's Web Inspector, lines `[translator] …`; the popup shows the timings.
- **Models**: the Languages page (sizes, "incomplete", delete and re-download); IndexedDB `translator` in the
  background's inspector (stores `fileInfo`, `fileData`, `kv`).
- **Odd output in one paragraph**: the engine moved or dropped a tag, so that unit fell back to text-node translation
  (`stats.fallbacks`). Look at `parseOut`/`applyUnit` in content.js and add the case to `jstest/unit.mjs`.

## Releasing

1. Bump `version` in `extension/manifest.json`; add a CHANGELOG entry.
2. `node tools/fetch-engine.mjs --check`, `node jstest/unit.mjs`, `jstest/run.sh test.mjs` green; look at the shots.
3. `scripts/scan-private.sh` (CI runs it too).
4. Tag `vX.Y.Z`; the release notes are the CHANGELOG entry.
