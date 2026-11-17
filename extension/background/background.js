/* Background: hosts the engine, routes messages from pages/popup, the right-click menu, the keyboard shortcut and
 * the toolbar badge.
 *
 * Two hosts, one engine (engine/engine.js):
 *  - Safari (and Firefox) run this as a background *page* (manifest background.scripts + preferred_environment
 *    "document"); the engine then runs in a dedicated Worker (engine/worker.js) so translating never blocks this page.
 *  - Chromium (used for the headless tests) only has a service worker, which can't start Workers; the engine runs
 *    inside the service worker itself (it is already off the page's main thread).
 */
"use strict";

const IS_SW = typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope;
if (IS_SW) {
  importScripts("../shared/common.js", "../engine/vendor/fzstd.js", "../engine/vendor/bergamot-translator.js",
    "../engine/vendor/fasttext_wasm.js", "../engine/vendor/fasttext.js", "../engine/engine.js");
}

/* ---------- engine host ---------- */
// Seam for a later optional "better quality" engine (cloud API): it would be a second host with the same
// call(method, args, onProgress) interface, chosen per request from a setting. Not built.
const VENDOR_SCRIPTS = ["engine/vendor/fzstd.js", "engine/vendor/bergamot-translator.js", "engine/vendor/fasttext_wasm.js",
  "engine/vendor/fasttext.js", "engine/engine.js"];

const engineHost = (() => {
  let inline = null;
  const makeInline = () => (inline ||= new TranslatorEngine({
    vendorUrl: api.runtime.getURL("engine/vendor/"),
    log: (...a) => console.log("[engine]", ...a),
  }));
  if (IS_SW || typeof Worker === "undefined") {
    return {
      kind: "inline",
      call: (method, args, onProgress) => makeInline()[method](args || {}, onProgress),
      reset() { inline = null; }, // drop the engine and its memory (as when the background is unloaded)
    };
  }
  // Background page: a Worker, or — if Safari won't start one here — the same engine in this page.
  let worker = null, ready = false, broken = false, seq = 0, loaded = null;
  const pending = new Map();
  const loadScripts = () => (loaded ||= VENDOR_SCRIPTS.reduce((prev, src) => prev.then(() => new Promise((res, rej) => {
    const el = document.createElement("script");
    el.src = api.runtime.getURL(src);
    el.onload = res;
    el.onerror = () => rej(new Error(`can't load ${src}`));
    document.head.append(el);
  })), Promise.resolve()));
  const callInline = async (method, args, onProgress) => { await loadScripts(); return makeInline()[method](args || {}, onProgress); };
  const giveUp = (why) => {
    console.warn(`[engine] worker failed (${why}); running the engine in the background page`);
    broken = true;
    const list = [...pending.values()];
    pending.clear();
    if (worker) worker.terminate();
    worker = null;
    for (const p of list) callInline(p.method, p.args, p.onProgress).then(p.resolve, p.reject);
  };
  const start = () => {
    ready = false;
    worker = new Worker(api.runtime.getURL("engine/worker.js"));
    const w = worker;
    setTimeout(() => { if (w === worker && !ready) giveUp("no answer in 8 s"); }, 8000);
    worker.onmessage = ({ data }) => {
      if (data.ready) { ready = true; return; }
      if (data.log) { console.log("[engine]", data.log); return; }
      const p = pending.get(data.id);
      if (!p) return;
      if (data.progress) { if (p.onProgress) p.onProgress(data.progress); return; }
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data.result);
    };
    worker.onerror = (e) => {
      if (!ready) { giveUp(e.message || "error"); return; }
      console.error("[engine] worker error", e.message);
      for (const p of pending.values()) p.reject(new Error(`The translation engine stopped (${e.message || "error"}).`));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  };
  try { navigator.storage.persist().catch(() => {}); } catch { /* not offered */ }
  return {
    get kind() { return broken ? "page" : "worker"; },
    reset() {
      if (worker) worker.terminate();
      worker = null;
      inline = null;
      for (const p of pending.values()) p.reject(new Error("The translation engine was restarted."));
      pending.clear();
    },
    call(method, args, onProgress) {
      if (broken) return callInline(method, args, onProgress);
      if (!worker) start();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress, method, args });
        worker.postMessage({ id, method, args });
      });
    },
  };
})();

const ENGINE_METHODS = new Set(["languages", "detect", "prepare", "translate", "remove", "download"]);

/* ---------- tab state (badge, frames that load later) ---------- */
const tabState = new Map(); // tabId -> { state, from, to }
const session = api.storage && api.storage.session;

async function getTabState(tabId) {
  if (tabState.has(tabId)) return tabState.get(tabId);
  if (session) {
    const k = `tab:${tabId}`;
    const v = (await session.get(k))[k];
    if (v) { tabState.set(tabId, v); return v; }
  }
  return { state: "idle" };
}

async function setTabState(tabId, st) {
  tabState.set(tabId, st);
  if (session) session.set({ [`tab:${tabId}`]: st }).catch(() => {});
  const text = st.state === "translated" ? (st.to || "").slice(0, 2).toUpperCase()
    : st.state === "translating" ? "…" : st.state === "error" ? "!" : "";
  try {
    await api.action.setBadgeText({ tabId, text });
    if (text) await api.action.setBadgeBackgroundColor({ tabId, color: st.state === "error" ? "#c2412d" : "#2f6f5b" });
  } catch { /* tab gone */ }
}

api.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  if (session) session.remove(`tab:${tabId}`).catch(() => {});
});

/* ---------- talking to tabs ---------- */
async function sendToTab(tabId, msg, frameId) {
  const opts = frameId == null ? undefined : { frameId };
  try {
    return await api.tabs.sendMessage(tabId, msg, opts);
  } catch (e) {
    // No content script there yet (page opened before install, or the site isn't allowed yet but the user just
    // clicked our button: activeTab). Inject and try once more.
    const target = frameId == null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
    await api.scripting.executeScript({ target, files: ["shared/common.js", "content/content.js"] });
    return await api.tabs.sendMessage(tabId, msg, opts);
  }
}

async function translateTab(tabId, from, to, manual = true) {
  await setTabState(tabId, { state: "translating", from, to });
  return sendToTab(tabId, { type: "translate", from, to, manual });
}

async function restoreTab(tabId) {
  await setTabState(tabId, { state: "idle" });
  return sendToTab(tabId, { type: "restore" });
}

/** Keyboard shortcut: translate with the detected language, or show the original. */
async function toggleTab(tabId) {
  const st = await sendToTab(tabId, { type: "status" }, 0);
  if (st && (st.state === "translated" || st.state === "translating")) return restoreTab(tabId);
  const { target } = await getSettings();
  const from = st && (st.from || (st.detected && st.detected.lang));
  if (!from) return sendToTab(tabId, { type: "notice", text: "Couldn't tell the page's language. Use the toolbar button." }, 0);
  if (from === target) return sendToTab(tabId, { type: "notice", text: `This page is already in ${langNames(target)}.` }, 0);
  return translateTab(tabId, from, target);
}

/* ---------- messages ---------- */
async function handle(msg, sender) {
  const tabId = msg.tabId != null ? msg.tabId : sender.tab ? sender.tab.id : null; // popup passes tabId
  switch (msg.type) {
    case "engine": {
      if (!ENGINE_METHODS.has(msg.method)) throw new Error(`unknown engine method ${msg.method}`);
      const onProgress = (p) => {
        const m = { type: "progress", ...p };
        if (sender.tab) api.tabs.sendMessage(sender.tab.id, m, { frameId: 0 }).catch(() => {});
        Promise.resolve(api.runtime.sendMessage(m)).catch(() => {}); // popup / Languages page, if open
      };
      return engineHost.call(msg.method, msg.args, onProgress);
    }
    case "hello": { // a content script started: should it translate right away?
      const settings = await getSettings();
      let host = "";
      try { host = new URL(sender.url).hostname; } catch { /* no url */ } // sender.url: the frame's own URL (tab.url needs "tabs")
      const st = await getTabState(tabId);
      if (sender.frameId === 0) {
        if (st.state !== "idle") await setTabState(tabId, { state: "idle" }); // a new page in this tab
        const site = settings.always[host];
        return { auto: site ? { from: site.from, to: settings.target } : null, chip: settings.chip };
      }
      // A sub-frame: follow the tab.
      return { auto: st.state === "translated" || st.state === "translating" ? { from: st.from, to: st.to } : null };
    }
    case "state": // from the top frame
      if (sender.frameId === 0 && tabId != null) await setTabState(tabId, { state: msg.state, from: msg.from, to: msg.to });
      return {};
    case "translateTab": // from the top frame (auto-translate) or the popup: all frames of the tab
      return translateTab(tabId, msg.from, msg.to, msg.manual !== false);
    case "restoreTab":
      return restoreTab(tabId);
    case "tabStatus": // popup
      return sendToTab(msg.tabId, { type: "status" }, 0);
    case "hostKind":
      return { kind: engineHost.kind };
    default:
      throw new Error(`unknown message ${msg.type}`);
  }
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "engine") return;
  port.onMessage.addListener(async ({ method, args }) => {
    let alive = true;
    port.onDisconnect.addListener(() => { alive = false; });
    const post = (m) => { if (alive) try { port.postMessage(m); } catch { alive = false; } };
    const beat = setInterval(() => post({ heartbeat: true }), 10_000);
    try {
      if (!ENGINE_METHODS.has(method)) throw new Error(`unknown engine method ${method}`);
      let last = 0;
      const result = await engineHost.call(method, args, (p) => {
        const now = Date.now();
        if (now - last > 150 || p.loaded === p.total) {
          last = now;
          post({ progress: p });
          Promise.resolve(api.runtime.sendMessage({ type: "progress", ...p })).catch(() => {}); // popup, Languages page
        }
      });
      post({ result });
    } catch (e) {
      post({ error: String(e && e.message || e) });
    } finally {
      clearInterval(beat);
    }
  });
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || msg.type === "progress") return false;
  handle(msg, sender).then((r) => sendResponse(r === undefined ? {} : r), (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});

/* ---------- right-click menu, shortcut ---------- */
const menus = api.contextMenus || api.menus;
async function setupMenus() {
  try { await menus.removeAll(); } catch { /* none */ }
  menus.create({ id: "translate-selection", title: "Translate Selection", contexts: ["selection"] });
}
setupMenus(); // every start: Safari keeps menu items only in memory

menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "translate-selection" || !tab) return;
  sendToTab(tab.id, { type: "translateSelection", text: info.selectionText || "" }, info.frameId || 0)
    .catch((e) => console.warn("translate selection:", e.message));
});

api.commands.onCommand.addListener(async (name, tab) => {
  if (name !== "translate-page") return;
  if (!tab) [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) toggleTab(tab.id).catch((e) => console.warn("toggle:", e.message));
});
