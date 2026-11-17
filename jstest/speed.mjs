// Speed of page translation in headless Chromium, as a proxy for Safari (the engine is single-threaded, so one
// core's speed is what counts).
// usage: ./run.sh speed.mjs [--runs N] [--url https://…] [--shots]   (default: fixtures/lang-artikel.html, ~1,300 words;
//        --url: a live page fetched now, nothing saved but numbers; --shots: out/speed-before.png, speed-after.png)
// Measures, from "Translate" to: first batch on screen, the visible screen done, the whole page done.
//   first use  = model downloaded (from jstest/.models, i.e. without network time), unpacked, checked, stored, loaded
//   cold       = models on disk, engine not loaded (engineHost.reset(): what Safari's idle unload does)
//   warm       = engine and model already loaded (second page)
import { launch, serveFixtures, tabIdOf, translate, restore, waitState, OUT } from "./lib.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const runs = Number(arg("--runs", 3));
const srv = await serveFixtures();
const url = arg("--url", srv.url + "lang-artikel.html");
const b = await launch();
const rows = [];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function once(label, page) {
  const tabId = await tabIdOf(b.sw, page);
  const t0 = Date.now();
  await translate(b.sw, tabId, "da", "en");
  const st = await waitState(b.sw, tabId, "translated", 300000);
  const s = st.stats;
  const row = {
    label, wall: Date.now() - t0,
    firstBatch: Math.round(s.firstBatchAt - s.startedAt), firstScreen: Math.round(s.firstScreenAt - s.startedAt),
    done: Math.round(s.doneAt - s.startedAt), prepare: s.prepareMs, words: s.words, engineMs: s.engineMs,
    wps: Math.round(s.words / (s.engineMs / 1000)), applyMs: Math.round(s.applyMs), collectMs: s.collectMs, batches: s.batches,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  await restore(b.sw, tabId);
  return row;
}

async function freshPage() {
  const page = await b.context.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(500);
  return page;
}

try {
  let page = await freshPage();
  const shots = process.argv.includes("--shots");
  await mkdir(OUT, { recursive: true });
  if (shots) await page.screenshot({ path: `${OUT}/speed-before.png` });
  if (shots) {
    // screenshot while translated (once() restores at the end)
    const tabId = await tabIdOf(b.sw, page);
    await translate(b.sw, tabId, "da", "en");
    await waitState(b.sw, tabId, "translated", 300000);
    await page.screenshot({ path: `${OUT}/speed-after.png` });
    await restore(b.sw, tabId);
    await b.sw.evaluate(() => engineHost.reset());
    await page.reload(); await page.waitForTimeout(500);
    rows.length = 0;
    await once("cold", page);
  } else await once("first use", page);
  for (let i = 0; i < runs; i++) { await page.reload(); await page.waitForTimeout(300); await once("warm", page); }
  for (let i = 0; i < runs; i++) {
    // Unload the engine (models stay on disk), as when Safari unloads the idle background after 30 s.
    await b.sw.evaluate(() => engineHost.reset());
    await page.close();
    page = await freshPage();
    await once("cold", page);
  }
  const sum = {};
  for (const l of ["first use", "warm", "cold"]) {
    const r = rows.filter((x) => x.label === l);
    sum[l] = Object.fromEntries(["firstBatch", "firstScreen", "done", "prepare", "wps", "words", "applyMs"].map((k) => [k, med(r.map((x) => x[k]))]));
  }
  console.log("\nmedians (ms; wps = words per second in the engine):");
  console.table(sum);
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/speed.json`, JSON.stringify({ when: new Date().toISOString(), url: url.startsWith(srv.url) ? url.replace(srv.url, "fixtures/") : url, rows, medians: sum }, null, 2));
} finally {
  await b.close();
  srv.close();
}
