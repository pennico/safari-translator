/* Shared by the content script, popup, Languages page and background. Classic script: defines globals. */
"use strict";

// Safari and Firefox have `browser` (promises); Chromium has `chrome` (promises in MV3 for the calls used here).
var api = (globalThis.browser && globalThis.browser.runtime) ? globalThis.browser : globalThis.chrome;

var DEFAULT_SETTINGS = {
  target: "en", // translate into
  always: {}, // hostname -> { from: "da" | "auto" }: translate automatically on that site
  chip: true, // show the small "Translated from …" note after translating a page
};

async function getSettings() {
  const s = await api.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return Object.assign({}, DEFAULT_SETTINGS, s);
}

async function setSettings(patch) {
  await api.storage.local.set(patch);
}

var langNames = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(["en"], { type: "language" }); } catch { /* old engines */ }
  const extra = { "zh-Hans": "Chinese (Simplified)", "zh-Hant": "Chinese (Traditional)", nb: "Norwegian Bokmål", nn: "Norwegian Nynorsk" };
  return (code) => extra[code] || (dn && code ? dn.of(code) : code) || code;
})();

/** "da-DK" -> "da", "no"/"nb-NO" -> "nb", "zh-TW" -> "zh-Hant", "zh-CN" -> "zh-Hans", "" -> null */
function normLang(tag) {
  if (!tag) return null;
  const t = String(tag).trim().replace("_", "-").toLowerCase();
  if (!t) return null;
  if (t.startsWith("zh")) return /hant|tw|hk|mo/.test(t) ? "zh-Hant" : "zh-Hans";
  const base = t.split("-")[0];
  if (base === "no") return "nb";
  if (base === "iw") return "he";
  if (base === "in") return "id";
  return base;
}

function fmtMB(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

/** runtime.sendMessage with an error when the background answers { error }. */
async function bg(msg) {
  const res = await api.runtime.sendMessage(msg);
  if (res && res.error) throw new Error(res.error);
  return res;
}

function engineCall(method, args) {
  return bg({ type: "engine", method, args });
}

/**
 * Engine calls that may take long (prepare = download + load, download) go through a port: Safari keeps the
 * background alive while it posts on an open port (progress, heartbeat), but not while a sendMessage reply is
 * pending (WebKit unloads an idle background after 30 s).
 */
function engineLong(method, args, onProgress) {
  return new Promise((resolve, reject) => {
    const port = api.runtime.connect({ name: "engine" });
    let settled = false;
    port.onMessage.addListener((m) => {
      if (m.progress) { if (onProgress) onProgress(m.progress); return; }
      if (m.heartbeat) return;
      settled = true;
      port.disconnect();
      if (m.error) reject(new Error(m.error)); else resolve(m.result);
    });
    port.onDisconnect.addListener(() => {
      if (!settled) { settled = true; reject(new Error("The translator's background stopped. Try again.")); }
    });
    port.postMessage({ method, args });
  });
}
