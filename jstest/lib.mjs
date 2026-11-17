// Shared helpers: a static server for fixtures, Chromium with extension/ loaded unpacked, and ways to drive it
// the way the popup / shortcut / context menu do (through the extension's service worker).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const EXT = join(HERE, "..", "extension");
export const OUT = join(HERE, "out");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };

export async function serveFixtures() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    if (path.includes("..")) { res.writeHead(400); res.end(); return; }
    try {
      // /ext/… serves the extension folder (webkit-engine.mjs runs the engine Worker as a plain page)
      const file = path.startsWith("ext/") ? join(EXT, path.slice(4)) : join(HERE, "fixtures", path || "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

/** Chromium with the extension, in a fresh profile each time: Chrome keeps an unpacked extension's old
 *  service-worker script in a reused profile, so edits would not load. Models still come from jstest/.models,
 *  so every run also goes through the first-use download (from the local cache, through the extension's code). */
export async function launch({ headless = true } = {}) {
  const dir = join(HERE, ".profiles", `run-${process.pid}-${Date.now()}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  // Mozilla's attachment CDN answers HTTP 406 to any Chrome user agent (Safari's and Node's get 200). The extension
  // itself is unchanged: the tests hand it the same Mozilla files, fetched here by Node and cached in jstest/.models.
  await context.route("https://firefox-settings-attachments.cdn.mozilla.net/**", (route) => cdnFromCache(route));
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  const logs = [];
  context.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  return { context, sw, id, logs, dir, close: async () => { await context.close(); await rm(dir, { recursive: true, force: true }); } };
}

/** The tab showing `page` (tab URLs are hidden without the "tabs" permission, so match by an id the page gets). */
export const cdnStats = { cached: 0, fetched: 0 };
async function cdnFromCache(route) {
  const url = new URL(route.request().url());
  const local = join(HERE, ".models", url.pathname.replace(/[^A-Za-z0-9._-]+/g, "_"));
  let body;
  try { body = await readFile(local); cdnStats.cached++; }
  catch {
    const res = await fetch(url);
    if (!res.ok) { await route.fulfill({ status: res.status, body: "" }); return; }
    body = Buffer.from(await res.arrayBuffer());
    await mkdir(join(HERE, ".models"), { recursive: true });
    await writeFile(local, body);
    cdnStats.fetched++;
  }
  await route.fulfill({ status: 200, body, headers: { "content-type": "application/octet-stream", "access-control-allow-origin": "*" } });
}

export async function tabIdOf(sw, page) {
  await page.bringToFront();
  return sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t ? t.id : null;
  });
}

export async function status(sw, tabId) {
  return sw.evaluate((t) => chrome.tabs.sendMessage(t, { type: "status" }, { frameId: 0 }), tabId);
}

export async function translate(sw, tabId, from, to) {
  return sw.evaluate(([t, f, to2]) => translateTab(t, f, to2), [tabId, from, to]);
}

export async function restore(sw, tabId) {
  return sw.evaluate((t) => restoreTab(t), tabId);
}

export async function waitState(sw, tabId, want, timeout = 120000) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeout) {
    st = await status(sw, tabId).catch((e) => ({ error: e.message }));
    if (st && st.state === want) return st;
    if (st && st.state === "error") throw new Error("translation error state");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${want}: ${JSON.stringify(st)}`);
}

/** Snapshot of the DOM that restore must reproduce exactly: outerHTML plus text-node identity markers. */
export async function domSnapshot(page) {
  return page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ALL);
    const parts = [];
    let n;
    if (!window.__ids) window.__ids = new WeakMap();
    let next = window.__nextId || 1;
    while ((n = w.nextNode())) {
      if (n.localName === "safari-translator-ui") continue;
      if (!window.__ids.has(n)) window.__ids.set(n, next++);
      const id = window.__ids.get(n);
      if (n.nodeType === 3) parts.push(`#${id}:${JSON.stringify(n.nodeValue)}`);
      else if (n.nodeType === 1) parts.push(`<${n.localName}#${id} ${[...n.attributes].map((a) => `${a.name}=${JSON.stringify(a.value)}`).join(" ")}>`);
      else parts.push(`?${n.nodeType}#${id}`);
    }
    window.__nextId = next;
    return { nodes: parts.join("\n"), title: document.title };
  });
}

export function check(results, name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Evaluate an expression in the content script's isolated world of the page's top frame (via CDP). */
export async function contentEval(page, expression) {
  const cdp = page.__cdp || (page.__cdp = await page.context().newCDPSession(page));
  if (!page.__ctxs) {
    page.__ctxs = [];
    cdp.on("Runtime.executionContextCreated", (e) => page.__ctxs.push(e.context));
    cdp.on("Runtime.executionContextsCleared", () => { page.__ctxs.length = 0; });
    await cdp.send("Runtime.enable");
  }
  const { frameTree } = await cdp.send("Page.getFrameTree");
  for (let i = 0; i < 50; i++) {
    const ctx = page.__ctxs.filter((c) => c.auxData && c.auxData.frameId === frameTree.frame.id && c.auxData.type === "isolated"
      && c.origin.startsWith("chrome-extension://")).pop();
    if (ctx) {
      const r = await cdp.send("Runtime.evaluate", { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result.value;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("content script world not found");
}
