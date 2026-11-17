/* Dedicated worker that hosts the engine (used where the background is a page: Safari, Firefox).
 * Protocol: in { id, method, args } → out { id, result } | { id, error } and, while it runs, { id, progress }. */
"use strict";
importScripts("vendor/fzstd.js", "vendor/bergamot-translator.js", "vendor/fasttext_wasm.js", "vendor/fasttext.js", "engine.js");

const engine = new TranslatorEngine({
  vendorUrl: new URL("vendor/", self.location.href).href,
  log: (...a) => postMessage({ log: a.map(String).join(" ") }),
});
const METHODS = new Set(["languages", "detect", "prepare", "translate", "remove", "download"]);

// One job at a time keeps the order of requests (Bergamot is synchronous anyway); downloads still overlap
// because their awaits yield.
self.onmessage = async ({ data }) => {
  const { id, method, args } = data;
  try {
    if (!METHODS.has(method)) throw new Error(`unknown method ${method}`);
    const result = await engine[method](args || {}, (progress) => postMessage({ id, progress }));
    postMessage({ id, result });
  } catch (e) {
    postMessage({ id, error: String(e && e.message || e) });
  }
};

postMessage({ ready: true });
