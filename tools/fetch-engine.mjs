#!/usr/bin/env node
// Downloads the third-party engine files into extension/engine/vendor/ and checks each against a pinned SHA-256.
// The files are committed, so this only runs to re-create or update them (then update the pins and THIRD-PARTY.md).
// Sources: Mozilla's Remote Settings CDN (the same files Firefox downloads), the Firefox source tree, npm (fzstd).
// usage: node tools/fetch-engine.mjs [--check]   (--check: only verify the committed files)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "extension/engine/vendor");
const CDN = "https://firefox-settings-attachments.cdn.mozilla.net/";
// Firefox main on 2026-11-17 (bergamot-translator.js v0.6.0+eea6e5a8, the glue for translations-wasm-v2 4.0).
const FX = "https://raw.githubusercontent.com/mozilla-firefox/firefox/77bdc2893ade1d2e9029d11fc4fe261fc310fe54/";
// Last Firefox revision that still had the fastText glue (removed in bug 1861516 when Firefox moved to CLD2).
const FX_FT = "https://raw.githubusercontent.com/mozilla-firefox/firefox/b89f381c448ced3c6aec7995ecde2df5f341ec79~1/";

export const FILES = [
  { out: "bergamot-translator.wasm", zstd: true,
    url: CDN + "main-workspace/translations-wasm-v2/a76f9efe-b185-4a7f-9c3b-5f5d216d12e6.zst",
    sha256: "327fcfc7b7e9d95f6fa0844ebf899cfc05469872ef02d3aef5783182839a6255",
    outSha256: "f38ef807636a7c994afedaab7ff8ffe0d590d21897f05139f747b80fd7bbe926" },
  { out: "bergamot-translator.js", url: FX + "toolkit/components/translations/bergamot-translator/bergamot-translator.js",
    sha256: "faff1ef6285b0d26f01787776fd49299dfb756ecb9688aa990c250e66797b47d" },
  { out: "LICENSE-bergamot.txt", url: FX + "toolkit/components/translations/bergamot-translator/LICENSE", sha256: "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5" },
  { out: "fasttext.wasm", url: CDN + "main-workspace/translations-wasm/5ee35b78-d0d4-43b0-8bee-e40fe57726b3.wasm",
    sha256: "ef84129d43648c3f0bded0e7cc3cb03b8855f22c7a1ab9d5515474b62ff3110e" },
  { out: "fasttext_wasm.js", url: FX_FT + "toolkit/components/translations/fasttext/fasttext_wasm.js",
    sha256: "34dd65d4ac93ec22e0b639441f9aae467fc5faf9e09d17b3e287f32b53182ead" },
  { out: "fasttext.js", url: FX_FT + "toolkit/components/translations/fasttext/fasttext.js",
    sha256: "da7bc3363fcb5fee454bf10260ba18abf90c37e71e5d75f7dd9faa7f505fdd4f" },
  { out: "LICENSE-fasttext.txt", url: FX_FT + "toolkit/components/translations/fasttext/LICENSE", sha256: "d9cfdfdf548c48712f05c67eb76c79e7c9f45cba78db50794b780e3564b85ef7" },
  { out: "lid.176.ftz",
    url: CDN + "main-workspace/translations-identification-models/fc2a4381-bc9e-47ad-8cff-a31163538e27.ftz",
    sha256: "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83" },
  { out: "fzstd.js", url: "https://unpkg.com/fzstd@0.1.1/umd/index.js",
    sha256: "fbea1c25c4413b620ca3f59e6037d9f6c675c5c7f690e4d660143188f686461d" },
  { out: "LICENSE-fzstd.txt", url: "https://unpkg.com/fzstd@0.1.1/LICENSE", sha256: "62249119bb7df6e54300f37a37145c26a6d4420410aac8881a119c5b427cf751" },
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const checkOnly = process.argv.includes("--check");
  mkdirSync(OUT, { recursive: true });
  let bad = 0;
  for (const f of FILES) {
    const path = join(OUT, f.out);
    const want = f.zstd ? f.outSha256 : f.sha256;
    if (checkOnly) {
      if (!existsSync(path)) { console.log(`MISSING ${f.out}`); bad++; continue; }
      const got = sha(readFileSync(path));
      if (want && got !== want) { console.log(`BAD     ${f.out} ${got}`); bad++; } else console.log(`ok      ${f.out}`);
      continue;
    }
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());
    const got = sha(buf);
    if (f.sha256 && got !== f.sha256) throw new Error(`${f.out}: sha256 ${got}, expected ${f.sha256}`);
    if (f.zstd) {
      const fzstd = createRequire(import.meta.url)(join(OUT, "fzstd.js"));
      buf = Buffer.from(fzstd.decompress(new Uint8Array(buf)));
      const out = sha(buf);
      if (out !== f.outSha256) throw new Error(`${f.out}: decompressed sha256 ${out}, expected ${f.outSha256}`);
    }
    writeFileSync(path, buf);
    console.log(`${f.out}  ${buf.length} bytes  sha256 ${sha(buf)}${f.sha256 ? "" : "  (not pinned)"}`);
  }
  if (bad) process.exit(1);
}

// fzstd is needed to unpack the engine, so fetch it first.
FILES.sort((a, b) => (a.out === "fzstd.js" ? -1 : b.out === "fzstd.js" ? 1 : 0));
main().catch((e) => { console.error(e.message); process.exit(1); });
