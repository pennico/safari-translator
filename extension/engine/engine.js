/* Translation engine: Mozilla's Bergamot (Marian) in WebAssembly for translation, fastText for language detection.
 * Models come from Mozilla's Remote Settings (the "translations-models-v2" collection Firefox uses), are checked
 * against their SHA-256, unpacked (zstd) and kept in this extension's IndexedDB. Page text never leaves this code.
 *
 * Runs in a dedicated Worker (Safari background page, engine/worker.js) or inside the extension service worker
 * (Chromium), loaded with importScripts after vendor/bergamot-translator.js, vendor/fasttext_wasm.js,
 * vendor/fasttext.js and vendor/fzstd.js. Classic script: defines the global TranslatorEngine.
 */
"use strict";

const ENGINE_CONST = {
  RECORDS_URL: "https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records",
  CDN: "https://firefox-settings-attachments.cdn.mozilla.net/",
  MODEL_MAJOR: 3, // Firefox's LANGUAGE_MODEL_MAJOR_VERSION_MIN/MAX for bergamot-translator 4.x
  RECORDS_MAX_AGE_MS: 24 * 3600 * 1000,
  MAX_LOADED_MODELS: 3, // a pair plus a pivot pair, and one spare; each tiny model is ~22 MB of WASM heap
  ALIGN: { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 },
  PIVOT: "en",
  DB: "translator",
};

/** Mozilla's version order: 3.0a1 < 3.0 < 3.1 (like Services.vc.compare for these simple versions). */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)(?:([a-z]+)(\d*))?$/.exec(v) || [];
    return [+m[1] || 0, +m[2] || 0, m[3] ? m[3] : "~", +m[4] || 0]; // "~" sorts after letters: release > pre-release
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Remote Settings filter expressions seen in the collection. We are "desktop, release channel"; unknown ones are skipped. */
function recordAllowed(r) {
  const f = (r.filter_expression || "").trim();
  return f === "" || f === "env.appinfo.OS != 'Android'";
}

/* ---------- IndexedDB ---------- */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ENGINE_CONST.DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("kv");
      db.createObjectStore("fileInfo", { keyPath: "id" });
      db.createObjectStore("fileData");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbReq(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
function idbDone(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); });
}

async function sha256Hex(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

class TranslatorEngine {
  constructor({ vendorUrl, log } = {}) {
    this.vendorUrl = vendorUrl; // where the bundled .wasm files live (engine/vendor/)
    this.log = log || (() => {});
    this.dbPromise = null;
    this.bergamot = null;
    this.bergamotPromise = null;
    this.service = null;
    this.models = new Map(); // "da-en" -> TranslationModel (insertion order = LRU order)
    this.modelPromises = new Map();
    this.downloads = new Map(); // "da-en" -> Promise
    this.records = null; // { fetchedAt, list }
    this.detector = null;
    this.detectorPromise = null;
  }

  db() { return (this.dbPromise ||= idbOpen()); }

  /* ---------- model records ---------- */
  async loadRecords({ refresh = false } = {}) {
    const db = await this.db();
    if (!this.records) this.records = await idbReq(db.transaction("kv").objectStore("kv").get("records")) || null;
    const stale = !this.records || Date.now() - this.records.fetchedAt > ENGINE_CONST.RECORDS_MAX_AGE_MS;
    if (refresh || stale) {
      try {
        const res = await fetch(ENGINE_CONST.RECORDS_URL, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()).data;
        if (!Array.isArray(list) || !list.length) throw new Error("empty model list");
        this.records = { fetchedAt: Date.now(), list };
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(this.records, "records");
        await idbDone(tx);
      } catch (e) {
        if (!this.records) throw new Error(`Can't get the list of language models from Mozilla (${e.message}).`);
        this.log("model list refresh failed, using the saved list", e.message);
      }
    }
    return this.records.list;
  }

  /** Best record set per language pair: newest allowed version with major MODEL_MAJOR. */
  async pairs() {
    const list = await this.loadRecords();
    const groups = new Map(); // "da-en@3.0" -> records
    for (const r of list) {
      if (!recordAllowed(r) || parseInt(r.version, 10) !== ENGINE_CONST.MODEL_MAJOR) continue;
      const key = `${r.sourceLanguage}-${r.targetLanguage}`;
      const g = groups.get(key) || new Map();
      const files = g.get(r.version) || [];
      files.push(r);
      g.set(r.version, files);
      groups.set(key, g);
    }
    const pairs = new Map();
    for (const [key, byVersion] of groups) {
      const versions = [...byVersion.keys()].sort(compareVersions).reverse();
      for (const v of versions) {
        const files = byVersion.get(v);
        const types = new Set(files.map((f) => f.fileType));
        if (!types.has("model") || !(types.has("vocab") || (types.has("srcvocab") && types.has("trgvocab")))) continue;
        const [from, to] = [files[0].sourceLanguage, files[0].targetLanguage];
        pairs.set(key, {
          from, to, version: v, architecture: files[0].architecture, files,
          downloadSize: files.reduce((s, f) => s + f.attachment.size, 0),
          size: files.reduce((s, f) => s + f.decompressedSize, 0),
        });
        break;
      }
    }
    return pairs;
  }

  async route(from, to) {
    const pairs = await this.pairs();
    if (from === to) return [];
    if (pairs.has(`${from}-${to}`)) return [pairs.get(`${from}-${to}`)];
    const P = ENGINE_CONST.PIVOT;
    if (from !== P && to !== P && pairs.has(`${from}-${P}`) && pairs.has(`${P}-${to}`)) {
      return [pairs.get(`${from}-${P}`), pairs.get(`${P}-${to}`)];
    }
    return null;
  }

  /** Everything the UI needs: languages, pairs, what's installed. */
  async languages({ refresh = false } = {}) {
    if (refresh) await this.loadRecords({ refresh: true });
    const pairs = await this.pairs();
    const installed = await this.installedFiles();
    const out = [];
    for (const p of pairs.values()) {
      const have = p.files.filter((f) => installed.has(f.id)).length;
      const stale = [...installed.values()].filter((i) => i.pair === `${p.from}-${p.to}` && !p.files.some((f) => f.id === i.id));
      out.push({
        from: p.from, to: p.to, version: p.version, architecture: p.architecture,
        downloadSize: p.downloadSize, size: p.size,
        installed: have === p.files.length, partial: have > 0 && have < p.files.length,
        installedSize: [...installed.values()].filter((i) => i.pair === `${p.from}-${p.to}`).reduce((s, i) => s + i.size, 0),
        outdated: stale.length > 0,
      });
    }
    // Files on disk whose pair is no longer offered by Mozilla still count as installed (and can be deleted).
    const listed = new Set(out.map((p) => `${p.from}-${p.to}`));
    for (const i of installed.values()) {
      if (listed.has(i.pair)) continue;
      listed.add(i.pair);
      const [from, to] = i.pair.split("-");
      out.push({ from, to, version: i.version, installed: false, partial: true, size: 0, downloadSize: 0,
        installedSize: [...installed.values()].filter((x) => x.pair === i.pair).reduce((s, x) => s + x.size, 0), orphan: true });
    }
    const fetchedAt = this.records ? this.records.fetchedAt : 0;
    return { pairs: out, fetchedAt, pivot: ENGINE_CONST.PIVOT };
  }

  async installedFiles() {
    const db = await this.db();
    const all = await idbReq(db.transaction("fileInfo").objectStore("fileInfo").getAll());
    return new Map(all.map((i) => [i.id, i]));
  }

  /* ---------- downloads ---------- */
  async ensureDownloaded(pair, onProgress) {
    const key = `${pair.from}-${pair.to}`;
    if (this.downloads.has(key)) return this.downloads.get(key);
    const p = this.#download(pair, onProgress).finally(() => this.downloads.delete(key));
    this.downloads.set(key, p);
    return p;
  }

  async #download(pair, onProgress) {
    const installed = await this.installedFiles();
    const missing = pair.files.filter((f) => !installed.has(f.id));
    if (!missing.length) return false;
    const total = missing.reduce((s, f) => s + f.attachment.size, 0);
    let done = 0;
    const report = (loaded) => onProgress && onProgress({ from: pair.from, to: pair.to, loaded: done + loaded, total });
    report(0);
    for (const f of missing) {
      const res = await fetch(ENGINE_CONST.CDN + f.attachment.location);
      if (!res.ok) throw new Error(`Download of ${f.name} failed: HTTP ${res.status}`);
      const chunks = [];
      let loaded = 0, lastReport = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        chunks.push(value);
        loaded += value.length;
        if (loaded - lastReport > 256 * 1024) { lastReport = loaded; report(loaded); }
      }
      const packed = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) { packed.set(c, off); off += c.length; }
      if ((await sha256Hex(packed)) !== f.attachment.hash) throw new Error(`${f.name}: checksum mismatch, not saved`);
      const data = f.attachment.mimetype === "application/zstd" || f.attachment.filename.endsWith(".zst")
        ? fzstd.decompress(packed) : packed;
      if (f.decompressedHash && (await sha256Hex(data)) !== f.decompressedHash) throw new Error(`${f.name}: checksum mismatch after unpacking`);
      const db = await this.db();
      const tx = db.transaction(["fileInfo", "fileData"], "readwrite");
      tx.objectStore("fileData").put(data.buffer.byteLength === data.length ? data.buffer : data.slice().buffer, f.id);
      tx.objectStore("fileInfo").put({
        id: f.id, name: f.name, pair: `${pair.from}-${pair.to}`, fileType: f.fileType, version: f.version,
        size: data.length, hash: f.decompressedHash || f.attachment.hash, storedAt: Date.now(),
      });
      await idbDone(tx);
      done += f.attachment.size;
      report(0);
    }
    // Older versions of the same pair are replaced.
    await this.#deleteFiles((i) => i.pair === `${pair.from}-${pair.to}` && !pair.files.some((f) => f.id === i.id));
    return true;
  }

  async #deleteFiles(match) {
    const installed = await this.installedFiles();
    const ids = [...installed.values()].filter(match).map((i) => i.id);
    if (!ids.length) return 0;
    const db = await this.db();
    const tx = db.transaction(["fileInfo", "fileData"], "readwrite");
    for (const id of ids) { tx.objectStore("fileInfo").delete(id); tx.objectStore("fileData").delete(id); }
    await idbDone(tx);
    return ids.length;
  }

  async remove({ from, to }) {
    const key = `${from}-${to}`;
    const m = this.models.get(key);
    if (m) { m.delete(); this.models.delete(key); }
    return { removed: await this.#deleteFiles((i) => i.pair === key) };
  }

  async download({ from, to }, onProgress) {
    const pairs = await this.pairs();
    const pair = pairs.get(`${from}-${to}`);
    if (!pair) throw new Error(`No model for ${from} → ${to}`);
    await this.ensureDownloaded(pair, onProgress);
    return { ok: true };
  }

  /* ---------- Bergamot ---------- */
  async initBergamot() {
    if (this.bergamot) return this.bergamot;
    return (this.bergamotPromise ||= (async () => {
      const t0 = performance.now();
      const wasm = await (await fetch(this.vendorUrl + "bergamot-translator.wasm")).arrayBuffer();
      const bergamot = await new Promise((resolve, reject) => {
        const mod = loadBergamot({
          INITIAL_MEMORY: 41_943_040, // Firefox's value: start at 40 MiB and let it grow
          print: (m) => this.log("bergamot:", m),
          printErr: (m) => this.log("bergamot err:", m),
          onAbort: () => reject(new Error("The translation engine (WASM) failed to load.")),
          onRuntimeInitialized: async () => { await Promise.resolve(); resolve(mod); },
          wasmBinary: wasm,
        });
      });
      this.service = new bergamot.BlockingService({ cacheSize: 0 });
      this.bergamot = bergamot;
      this.log(`engine ready in ${Math.round(performance.now() - t0)} ms`);
      return bergamot;
    })().catch((e) => { this.bergamotPromise = null; throw e; }));
  }

  async loadModel(pair) {
    const key = `${pair.from}-${pair.to}`;
    if (this.models.has(key)) {
      const m = this.models.get(key);
      this.models.delete(key); this.models.set(key, m); // LRU touch
      return m;
    }
    if (this.modelPromises.has(key)) return this.modelPromises.get(key);
    const p = (async () => {
      const B = await this.initBergamot();
      const t0 = performance.now();
      const db = await this.db();
      const tx = db.transaction("fileData");
      const store = tx.objectStore("fileData");
      const buffers = {};
      await Promise.all(pair.files.map(async (f) => {
        const buf = await idbReq(store.get(f.id));
        if (!buf) throw new Error(`Model file ${f.name} is missing; download it again.`);
        buffers[f.fileType] = { buf, name: f.name };
      }));
      const mem = {};
      for (const [type, { buf }] of Object.entries(buffers)) {
        const a = new B.AlignedMemory(buf.byteLength, ENGINE_CONST.ALIGN[type]);
        a.getByteArrayView().set(new Uint8Array(buf));
        mem[type] = a;
      }
      const vocabs = new B.AlignedMemoryList();
      if (mem.vocab) vocabs.push_back(mem.vocab);
      else { vocabs.push_back(mem.srcvocab); vocabs.push_back(mem.trgvocab); }
      // Same settings as Firefox's translations-engine.worker.js.
      const cfg = {
        "beam-size": "1", normalize: "1.0", "word-penalty": "0", "max-length-break": "128",
        "mini-batch-words": "1024", workspace: "128", "max-length-factor": "2.0", "skip-cost": "true",
        "cpu-threads": "0", quiet: "true", "quiet-translation": "true",
        "gemm-precision": buffers.model.name.endsWith("intgemm8.bin") ? "int8shiftAll" : "int8shiftAlphaAll",
        alignment: "soft",
      };
      const indent = "            ";
      const config = "\n" + Object.entries(cfg).map(([k, v]) => `${indent}${k}: ${v}\n`).join("") + indent;
      const model = new B.TranslationModel(pair.from, pair.to, config, mem.model, mem.lex || null, vocabs, null);
      this.models.set(key, model);
      while (this.models.size > ENGINE_CONST.MAX_LOADED_MODELS) {
        const [oldKey, old] = this.models.entries().next().value;
        old.delete(); this.models.delete(oldKey);
      }
      this.log(`model ${key} loaded in ${Math.round(performance.now() - t0)} ms`);
      return model;
    })().finally(() => this.modelPromises.delete(key));
    this.modelPromises.set(key, p);
    return p;
  }

  /** Download (if needed) and load the models for from → to. */
  async prepare({ from, to }, onProgress) {
    const route = await this.route(from, to);
    if (!route) throw new Error(`No language model for ${from} → ${to}.`);
    for (const pair of route) await this.ensureDownloaded(pair, onProgress);
    for (const pair of route) await this.loadModel(pair);
    return { route: route.map((p) => [p.from, p.to]) };
  }

  /**
   * items: [{ text, html }]. Returns { texts, ms }. Leading/trailing whitespace is kept as in Firefox,
   * soft hyphens are removed (they break tokenisation), empty items are passed through.
   */
  async translate({ from, to, items }) {
    const route = await this.route(from, to);
    if (!route) throw new Error(`No language model for ${from} → ${to}.`);
    if (!route.length) return { texts: items.map((i) => i.text), ms: 0 };
    const models = [];
    for (const pair of route) models.push(await this.loadModel(pair));
    const B = this.bergamot;
    const out = new Array(items.length);
    const idx = [];
    const msgs = new B.VectorString();
    const opts = new B.VectorResponseOptions();
    const ws = [];
    items.forEach((it, i) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(it.text);
      const core = m[2].replaceAll("­", "");
      if (!core) { out[i] = it.text; return; }
      idx.push(i); ws.push([m[1], m[3]]);
      msgs.push_back(core);
      opts.push_back({ qualityScores: false, alignment: true, html: !!it.html });
    });
    const t0 = performance.now();
    let responses = null;
    try {
      if (idx.length) {
        responses = models.length === 1
          ? this.service.translate(models[0], msgs, opts)
          : this.service.translateViaPivoting(models[0], models[1], msgs, opts);
        for (let j = 0; j < idx.length; j++) out[idx[j]] = ws[j][0] + responses.get(j).getTranslatedText() + ws[j][1];
      }
    } finally {
      msgs.delete(); opts.delete(); if (responses) responses.delete();
    }
    return { texts: out, ms: Math.round(performance.now() - t0) };
  }

  /* ---------- language detection (fastText lid.176, as Firefox used before its move to CLD2) ---------- */
  async initDetector() {
    if (this.detector) return this.detector;
    return (this.detectorPromise ||= (async () => {
      const [wasm, model] = await Promise.all(["fasttext.wasm", "lid.176.ftz"].map(async (f) =>
        new Uint8Array(await (await fetch(this.vendorUrl + f)).arrayBuffer())));
      await new Promise((resolve) => { addOnPostRun(resolve); loadFastText({ wasmBinary: wasm }); });
      const ft = new FastText(fastTextModule);
      this.detector = ft.loadModelBinary(model);
      return this.detector;
    })().catch((e) => { this.detectorPromise = null; throw e; }));
  }

  /** Returns { lang, confidence, top: [[lang, p], ...] }; lang codes as in the model list (nb, zh-Hans …). */
  async detect({ text }) {
    const model = await this.initDetector();
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 4000);
    if (!clean) return { lang: null, confidence: 0, top: [] };
    const res = model.predict(clean, 3, 0.0);
    const top = [];
    for (let i = 0; i < res.size(); i++) {
      const [p, label] = res.get(i);
      top.push([TranslatorEngine.mapFastTextLabel(label.replace("__label__", "")), p]);
    }
    if (res.delete) res.delete();
    return { lang: top[0] ? top[0][0] : null, confidence: top[0] ? top[0][1] : 0, top };
  }

  static mapFastTextLabel(code) {
    return { no: "nb", zh: "zh-Hans", sh: "hr", iw: "he", in: "id", tl: "tl" }[code] || code;
  }
}

if (typeof module !== "undefined") module.exports = { TranslatorEngine, compareVersions, recordAllowed };
