# Third-party files

Bundled in `extension/engine/vendor/` (pinned by SHA-256 in `tools/fetch-engine.mjs`):

| File | What | Source | Licence |
|---|---|---|---|
| `bergamot-translator.wasm` | Mozilla's translation engine (Bergamot/Marian), v0.6.0, record 4.0 | Mozilla Remote Settings `translations-wasm-v2` (zstd, unpacked here), built from mozilla/translations `inference/` rev 1de4a085 | MPL-2.0 (`LICENSE-bergamot.txt`) |
| `bergamot-translator.js` | its Emscripten glue, v0.6.0+eea6e5a8 | Firefox tree `toolkit/components/translations/bergamot-translator/` at 77bdc289 (2026-11-17) | MPL-2.0 |
| `fasttext.wasm` | fastText v0.9.2 compiled to WASM | Mozilla Remote Settings `translations-wasm` (record 1.0) | MIT (`LICENSE-fasttext.txt`) |
| `fasttext_wasm.js`, `fasttext.js` | its glue and wrapper | Firefox tree `toolkit/components/translations/fasttext/` before its removal (rev b89f381c~1) | MIT |
| `lid.176.ftz` | fastText language identification model (176 languages) | Mozilla Remote Settings `translations-identification-models` | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) (Facebook, now Meta; [fasttext.cc](https://fasttext.cc/docs/en/language-identification.html)), unchanged |
| `fzstd.js` | zstd decompression in JavaScript, v0.1.1 | npm `fzstd` (umd build) | MIT (`LICENSE-fzstd.txt`) |

Downloaded at runtime, not bundled: Mozilla's translation models (Remote Settings `translations-models-v2`),
MPL-2.0 ("The model files are distributed under the MPL 2.0 license", mozilla/translations README).

This project's own code is MPL-2.0 too (`LICENSE`).
