# AGENTS.md

Read README.md (what it does, how it works, limits) and DEVELOPMENT.md (layout, tests, engine updates) first;
BUILD.md is the Mac build.

Rules:

- Page text never goes to any external service. The only network use is Mozilla's model list and model files.
- The engine stays Mozilla's WASM build with Firefox's glue (pinned in `tools/fetch-engine.mjs`).
- `node jstest/unit.mjs` and `jstest/run.sh test.mjs` must pass before a commit; look at `jstest/run.sh shots.mjs`
  after UI changes.
- No secrets or personal details in the tree: `scripts/scan-private.sh` (CI) checks it.
- A maintainer's local notes may be in `private/` (git-ignored); read them if they exist.
