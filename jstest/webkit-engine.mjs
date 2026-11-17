// The engine (Mozilla's WASM + Firefox's glue + our engine.js) in WebKit — Safari's engine family — and, for
// comparison, Chromium, both as a plain page running engine/worker.js. Models are downloaded from Mozilla's CDN
// (WebKit sends a Safari user agent, which the CDN accepts; Chromium's is refused, so it gets the local cache).
// usage: ./run.sh webkit-engine.mjs
import { webkit, chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { serveFixtures, HERE, OUT } from "./lib.mjs";
import { join } from "node:path";

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1"; // libraries come from .libs (webkit-run.sh)
const srv = await serveFixtures();
const html = await readFile(join(HERE, "fixtures", "lang-artikel.html"), "utf8");
const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()).slice(0, 12);
const results = {};
for (const [name, type, opts] of [
  ["webkit", webkit, { executablePath: join(HERE, "webkit-run.sh") }],
  ["chromium", chromium, {}],
]) {
  const browser = await type.launch(opts);
  const ctx = await browser.newContext();
  if (name === "chromium") {
    await ctx.route("https://firefox-settings-attachments.cdn.mozilla.net/**", async (route) => {
      const url = new URL(route.request().url());
      const body = await readFile(join(HERE, ".models", url.pathname.replace(/[^A-Za-z0-9._-]+/g, "_"))).catch(() => null);
      if (body) await route.fulfill({ status: 200, body, headers: { "access-control-allow-origin": "*" } });
      else await route.continue();
    });
  }
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`${name} console:`, m.text()); });
  await page.goto(srv.url + "engine.html");
  const ua = await page.evaluate(() => navigator.userAgent);
  try {
    const r = await page.evaluate((t) => window.runEngine(t), paras);
    results[name] = { ua, ...r };
    console.log(`${name}: ready ${r.readyMs} ms, detect ${r.detect.lang} ${r.detect.confidence.toFixed(2)} (${r.detectMs} ms incl. load), prepare ${r.prepareMs} ms (download+unpack+load), ${r.words} words in ${r.runsMs.join("/")} ms = ${r.wps} words/s`);
    console.log(`   ${r.sample}`);
    console.log(`   ${r.html}`);
  } catch (e) {
    results[name] = { ua, error: e.message };
    console.log(`${name}: ERROR ${e.message}`);
  }
  await browser.close();
}
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "webkit-engine.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
srv.close();
process.exit(Object.values(results).some((r) => r.error) ? 1 : 0);
