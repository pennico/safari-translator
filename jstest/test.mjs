// The extension's acceptance tests in headless Chromium (extension/ loaded unpacked).
// usage: ./run.sh test.mjs   (fresh browser profile each run; model files come from jstest/.models, see lib.mjs)
// Exit code 0 = all passed. Results also in out/test-results.json.
import { launch, serveFixtures, tabIdOf, translate, restore, waitState, status, domSnapshot, contentEval, check, OUT, cdnStats } from "./lib.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const results = [];
const srv = await serveFixtures();
const b = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const html = (page, sel) => page.$eval(sel, (e) => e.innerHTML.replace(/\s+/g, " ").trim());
const swCall = (fn, arg) => b.sw.evaluate(fn, arg);

try {
  /* ---------- engine, both hosts ---------- */
  const prep = await swCall(async () => {
    const t = performance.now();
    await engineHost.call("prepare", { from: "da", to: "en" });
    return Math.round(performance.now() - t);
  });
  check(results, "engine: da→en model ready (service-worker host)", prep >= 0, `${prep} ms incl. download from the local cache, unpack, check, store`);
  const tr = await swCall(() => engineHost.call("translate", { from: "da", to: "en", items: [
    { text: "Det regner i Aarhus i dag.", html: false },
    { text: 'Læs <span data-t="0">hele artiklen</span> her.', html: true },
    { text: "   ", html: false },
  ] }));
  check(results, "engine: plain text", /rain/i.test(tr.texts[0]), tr.texts[0]);
  check(results, "engine: HTML mode keeps the tag", /<span data-t="0">[^<]+<\/span>/.test(tr.texts[1]), tr.texts[1]);
  check(results, "engine: blank text passes through", tr.texts[2] === "   ");
  const langs = await swCall(() => engineHost.call("languages", {}));
  const da = langs.pairs.filter((p) => p.from === "da" || p.to === "da").map((p) => `${p.from}→${p.to} ${p.version} ${p.architecture} ${(p.downloadSize / 1e6).toFixed(1)}MB`);
  check(results, "models: Danish both ways listed", da.length === 2, da.join(", "));
  const pivot = await swCall(async () => {
    const t = performance.now();
    await engineHost.call("prepare", { from: "da", to: "it" });
    const r = await engineHost.call("translate", { from: "da", to: "it", items: [{ text: "Det regner i Aarhus i dag, og vi bliver hjemme.", html: false }] });
    return { text: r.texts[0], ms: Math.round(performance.now() - t) };
  });
  check(results, "engine: pivot da→en→it", /piov|Aarhus/i.test(pivot.text), `${pivot.text} (${pivot.ms} ms)`);
  const det = await swCall(() => Promise.all([
    "Regeringen vil sænke skatten på arbejde, siger statsministeren.",
    "The government wants to cut taxes on work.",
    "Regeringen vill sänka skatten på arbete, säger statsministern.",
  ].map((t) => engineHost.call("detect", { text: t }))));
  check(results, "detect: da / en / sv", det[0].lang === "da" && det[1].lang === "en" && det[2].lang === "sv",
    det.map((d) => `${d.lang} ${d.confidence.toFixed(2)}`).join(", "));

  // The Worker host (what Safari's background page uses): run engine/worker.js from an extension page.
  const extPage = await b.context.newPage();
  await extPage.goto(`chrome-extension://${b.id}/options/languages.html`);
  const viaWorker = await extPage.evaluate(() => new Promise((resolve, reject) => {
    const w = new Worker(chrome.runtime.getURL("engine/worker.js"));
    const t = performance.now();
    let ready = false;
    w.onmessage = ({ data }) => {
      if (data.ready) { ready = true; w.postMessage({ id: 1, method: "translate", args: { from: "da", to: "en", items: [{ text: "God morgen, Danmark.", html: false }] } }); return; }
      if (data.id === 1) { w.terminate(); data.error ? reject(new Error(data.error)) : resolve({ ready, text: data.result.texts[0], ms: Math.round(performance.now() - t) }); }
    };
    w.onerror = (e) => reject(new Error(e.message));
  }));
  check(results, "engine: Worker host (Safari's path)", viaWorker.ready && /morning/i.test(viaWorker.text), `${viaWorker.text} (${viaWorker.ms} ms cold)`);

  /* ---------- page translation ---------- */
  const page = await b.context.newPage();
  await page.goto(srv.url + "nyhed.html");
  await page.waitForTimeout(300);
  const tabId = await tabIdOf(b.sw, page);
  const st0 = await status(b.sw, tabId);
  check(results, "page: language detected as Danish", st0.detected.lang === "da", `${st0.detected.lang} ${st0.detected.confidence.toFixed(2)} (${st0.detected.how})`);
  // Prepare state the page and its frames hold, to see it survive.
  await page.evaluate(() => {
    window.__link1 = document.getElementById("link1");
    window.__iframeWin = document.getElementById("frame").contentWindow;
    window.__iframeWin.__marker = 42;
  });
  const before = await domSnapshot(page);
  const origCode = await html(page, "#mixed code");
  const origPre = await text(page, "#pre");
  await translate(b.sw, tabId, "da", "en");
  const st1 = await waitState(b.sw, tabId, "translated");
  check(results, "page: translated", /rain/i.test(await text(page, "#headline")), await text(page, "#headline"));
  check(results, "page: inline link kept, same element", await page.evaluate(() => document.getElementById("link1") === window.__link1 && !!document.querySelector("#p1 > a#link1")), await html(page, "#p1"));
  check(results, "page: bold kept", /<strong>[^<]+<\/strong>/.test(await html(page, "#lead")), await html(page, "#lead"));
  check(results, "page: <code>, <kbd>, <pre> untouched", (await html(page, "#mixed code")) === origCode && (await text(page, "#pre")) === origPre && /<kbd>F5<\/kbd>/.test(await html(page, "#mixed")));
  check(results, "page: space kept after </code>", /<\/code> \S/.test(await html(page, "#mixed")), await html(page, "#mixed"));
  check(results, "page: translate=no / .notranslate / contenteditable / textarea untouched",
    (await text(page, "#notr")) === "Denne sætning må ikke oversættes." && (await text(page, "#notr2")) === "Heller ikke denne sætning."
    && (await text(page, "#editor")) === "Skriv din kommentar her." && (await page.$eval("#ta", (e) => e.value)) === "Det her er en kladde.");
  const attrs = await page.evaluate(() => ({
    placeholder: document.querySelector("input[type=search]").placeholder,
    alt: document.getElementById("photo").alt,
    aria: document.querySelector("nav").getAttribute("aria-label"),
    title: document.getElementById("frame").title,
  }));
  check(results, "page: attributes (placeholder, alt, aria-label, title) translated",
    !/Søg/.test(attrs.placeholder) && !/Oversvømmet/.test(attrs.alt) && !/Hovedmenu/.test(attrs.aria) && attrs.title !== "Regnkort", JSON.stringify(attrs));
  check(results, "page: document title translated", /rain/i.test(await page.title()), await page.title());
  check(results, "page: iframe not reloaded, video not moved",
    await page.evaluate(() => document.getElementById("frame").contentWindow === window.__iframeWin && window.__iframeWin.__marker === 42
      && document.getElementById("vid").parentNode.id === "withvideo"));
  await page.click("#clickme");
  check(results, "page: page's own click handler still works", (await page.evaluate(() => window.clicks)) === 1);
  check(results, "page: name with translate=no inside a caption kept", /Lars Øster/.test(await text(page, "figcaption")), await text(page, "figcaption"));
  check(results, "page: cards (block-styled spans) translated separately",
    !/Sådan|Fem enkle/.test(await text(page, "#card1")), await html(page, "#card1"));
  const stats = st1.stats;
  check(results, "page: no HTML fallbacks needed", stats.fallbacks === 0, `fallbacks ${stats.fallbacks}, units ${stats.units}, words ${stats.words}, batches ${stats.batches}`);

  /* ---------- content added later ---------- */
  await page.click("#more");
  await page.evaluate(() => { window.addNews(); });
  await page.waitForFunction(() => document.querySelectorAll("#feed article").length === 2);
  await sleep(1500);
  const feed = await text(page, "#feed");
  check(results, "dynamic: new articles translated", !/Limfjorden åbner|Skolebørn plantede/.test(feed) && /bridge|trees/i.test(feed), feed.slice(0, 160));
  await page.evaluate(() => { window.liveText.nodeValue = "Siden er opdateret lige nu af redaktionen."; });
  await sleep(1200);
  const footer = await text(page, "#footer");
  check(results, "dynamic: text changed by the page is translated again", /updated|editor/i.test(footer) && !/opdateret/.test(footer), footer);
  check(results, "dynamic: counter span kept and updated", (await text(page, "#count")) === "2", await text(page, "#counter"));

  /* ---------- restore ---------- */
  await restore(b.sw, tabId);
  await sleep(300);
  const feedBack = await text(page, "#feed");
  check(results, "restore: added articles back in Danish", /Ny bro over Limfjorden/.test(feedBack) && /Skolebørn plantede/.test(feedBack), feedBack.slice(0, 120));
  // Exact restore on a clean load: same nodes, same text, same attributes, same title.
  await page.reload();
  await page.waitForTimeout(300);
  const tab2 = await tabIdOf(b.sw, page);
  const clean = await domSnapshot(page);
  await translate(b.sw, tab2, "da", "en");
  await waitState(b.sw, tab2, "translated");
  const mid = await domSnapshot(page);
  await restore(b.sw, tab2);
  await sleep(300);
  const after = await domSnapshot(page);
  check(results, "restore: exact (every node, text, attribute and the title)", after.nodes === clean.nodes && after.title === clean.title && mid.nodes !== clean.nodes,
    after.nodes === clean.nodes ? `${clean.nodes.split("\n").length} nodes compared` : "differs");
  void before;

  /* ---------- selection bubble (right-click → Translate Selection) ---------- */
  await page.evaluate(() => {
    const p = document.getElementById("p2");
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await swCall((t) => sendToTab(t, { type: "translateSelection", text: "" }, 0), tab2);
  let bubble = null;
  for (let i = 0; i < 100 && !(bubble && !/Translating/.test(bubble)); i++) { await sleep(100); bubble = await contentEval(page, "__stTranslatorDebug.bubbleText()"); }
  const bl = await contentEval(page, "__stTranslatorDebug.bubbleLangs()");
  check(results, "selection: bubble shows the translation", bubble && /rain|meteorologist/i.test(bubble) && bl[0] === "da" && bl[1] === "en", `${bl} | ${bubble}`);
  check(results, "selection: page itself untouched", /Vi forventer/.test(await text(page, "#p2")));

  /* ---------- shortcut (same function as the command handler) ---------- */
  await swCall((t) => toggleTab(t), tab2);
  await waitState(b.sw, tab2, "translated");
  check(results, "shortcut: translates with the detected language", /rain/i.test(await text(page, "#headline")));
  await swCall((t) => toggleTab(t), tab2);
  await sleep(300);
  check(results, "shortcut: second press shows the original", /Kraftig regn/.test(await text(page, "#headline")));

  /* ---------- English page, page without lang ---------- */
  const en = await b.context.newPage();
  await en.goto(srv.url + "english.html");
  await en.waitForTimeout(300);
  const tabEn = await tabIdOf(b.sw, en);
  await swCall((t) => toggleTab(t), tabEn);
  await sleep(500);
  const chipEn = await contentEval(en, "__stTranslatorDebug.chipText()");
  check(results, "English page (shortcut): says it's already English, does nothing", /already in English/.test(chipEn || "") && /Heavy rain expected/.test(await text(en, "h1")), chipEn);
  const popEn = await b.context.newPage();
  await popEn.goto(`chrome-extension://${b.id}/popup/popup.html?tab=${tabEn}`);
  await popEn.waitForFunction(() => document.getElementById("to").options.length > 5, null, { timeout: 15000 });
  await popEn.waitForTimeout(300);
  const enBtn = await popEn.$eval("#main", (e) => [e.textContent, e.disabled]);
  check(results, "English page (popup): button says 'Already in English', disabled", enBtn[0] === "Already in English" && enBtn[1], JSON.stringify(enBtn));
  await popEn.close();
  const nl = await b.context.newPage();
  await nl.goto(srv.url + "uden-lang.html");
  await nl.waitForTimeout(300);
  const stNl = await status(b.sw, await tabIdOf(b.sw, nl));
  check(results, "page without lang attribute: detected from text", stNl.detected.lang === "da", `${stNl.detected.lang} ${stNl.detected.confidence.toFixed(2)}`);

  /* ---------- popup ---------- */
  await page.bringToFront();
  const popup = await b.context.newPage();
  await popup.setViewportSize({ width: 300, height: 260 });
  await popup.goto(`chrome-extension://${b.id}/popup/popup.html?tab=${tab2}`);
  await popup.waitForFunction(() => !document.getElementById("main").disabled, null, { timeout: 15000 });
  const pv = await popup.evaluate(() => ({ from: document.getElementById("from").value, to: document.getElementById("to").value, note: document.getElementById("note").textContent, main: document.getElementById("main").textContent }));
  check(results, "popup: detected Danish → English, Translate", pv.from === "da" && pv.to === "en" && pv.main === "Translate", JSON.stringify(pv));
  await popup.click("#main");
  await waitState(b.sw, tab2, "translated");
  await popup.waitForFunction(() => document.getElementById("main").textContent === "Show original", null, { timeout: 15000 });
  check(results, "popup: Translate works, button turns into Show original", /rain/i.test(await text(page, "#headline")));
  await popup.click("#main");
  await sleep(400);
  check(results, "popup: Show original", /Kraftig regn/.test(await text(page, "#headline")));
  await popup.selectOption("#to", "de");
  await popup.reload();
  await popup.waitForFunction(() => document.getElementById("to").options.length > 5, null, { timeout: 15000 });
  check(results, "popup: target language remembered", (await popup.$eval("#to", (s) => s.value)) === "de");
  await popup.selectOption("#to", "en");
  await popup.check("#always");
  await sleep(1500);
  const settings = await swCall(() => chrome.storage.local.get(null));
  check(results, "popup: 'Always translate this site' saved", settings.always && settings.always["127.0.0.1"] && settings.target === "en", JSON.stringify(settings));
  await page.reload();
  await page.waitForTimeout(300);
  const tab3 = await tabIdOf(b.sw, page);
  await waitState(b.sw, tab3, "translated");
  check(results, "always: page translated by itself after reload", /rain/i.test(await text(page, "#headline")));
  await popup.goto(`chrome-extension://${b.id}/popup/popup.html?tab=${tab3}`);
  await popup.waitForFunction(() => document.getElementById("always").checked, null, { timeout: 15000 });
  await popup.uncheck("#always");
  await sleep(300);
  const s2 = await swCall(() => chrome.storage.local.get("always"));
  check(results, "popup: 'Always' can be turned off", !s2.always["127.0.0.1"]);

  /* ---------- Languages page ---------- */
  await extPage.reload();
  await extPage.waitForSelector("#installed table");
  const inst = await extPage.$$eval("#installed tr", (rows) => rows.map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check(results, "Languages: models on disk listed with size", inst.some((r) => /Danish → English.*MB/.test(r)), inst.slice(1).join(" | "));
  extPage.once("dialog", (d) => d.accept());
  const row = extPage.locator("#installed tr", { hasText: "English → Italian" });
  await row.locator("button").click();
  await extPage.waitForFunction(() => ![...document.querySelectorAll("#installed tr")].some((r) => r.textContent.includes("English → Italian")), null, { timeout: 15000 });
  const left = await swCall(async () => (await engineHost.call("languages", {})).pairs.filter((p) => p.installedSize > 0).map((p) => `${p.from}-${p.to}`));
  check(results, "Languages: Delete removes a model", !left.includes("en-it") && left.includes("da-en"), left.join(", "));
  await extPage.click("#speed");
  await extPage.waitForFunction(() => /words\/s|error|failed/i.test(document.getElementById("speedOut").textContent), null, { timeout: 60000 });
  const speedOut = await extPage.$eval("#speedOut", (e) => e.textContent);
  check(results, "Languages: speed check runs", /words\/s/.test(speedOut), speedOut);
} catch (e) {
  check(results, "no exceptions", false, e.stack.split("\n").slice(0, 3).join(" "));
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed; model files from cache ${cdnStats.cached}, fetched ${cdnStats.fetched}`);
  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/test-results.json`, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
  if (failed.length) console.log(b.logs.slice(-30).join("\n"));
  await b.close();
  srv.close();
  process.exit(failed.length ? 1 : 0);
}
