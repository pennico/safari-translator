// Screenshots of the popup, the Languages page, the selection bubble and the page note, light and dark.
// usage: ./run.sh shots.mjs   → out/shot-*.png
import { launch, serveFixtures, tabIdOf, translate, waitState, OUT } from "./lib.mjs";
import { mkdir } from "node:fs/promises";

await mkdir(OUT, { recursive: true });
const srv = await serveFixtures();
const b = await launch();
try {
  const page = await b.context.newPage();
  await page.goto(srv.url + "nyhed.html");
  await page.waitForTimeout(300);
  const tab = await tabIdOf(b.sw, page);
  for (const scheme of ["light", "dark"]) {
    const popup = await b.context.newPage();
    await popup.emulateMedia({ colorScheme: scheme });
    await popup.setViewportSize({ width: 300, height: 232 });
    await popup.goto(`chrome-extension://${b.id}/popup/popup.html?tab=${tab}`);
    await popup.waitForFunction(() => !document.getElementById("main").disabled, null, { timeout: 20000 });
    await popup.screenshot({ path: `${OUT}/shot-popup-${scheme}.png` });
    await popup.close();
  }
  await translate(b.sw, tab, "da", "en");
  await waitState(b.sw, tab, "translated");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/shot-page-translated.png` });
  const popup = await b.context.newPage();
  await popup.setViewportSize({ width: 300, height: 232 });
  await popup.goto(`chrome-extension://${b.id}/popup/popup.html?tab=${tab}`);
  await popup.waitForFunction(() => document.getElementById("main").textContent === "Show original", null, { timeout: 20000 });
  await popup.screenshot({ path: `${OUT}/shot-popup-translated.png` });
  await popup.close();
  await b.sw.evaluate((t) => restoreTab(t), tab);
  await page.bringToFront();
  await page.evaluate(() => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("p3"));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.getElementById("p3").scrollIntoView({ block: "center" });
  });
  await b.sw.evaluate((t) => sendToTab(t, { type: "translateSelection", text: "" }, 0), tab);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/shot-bubble.png` });
  for (const scheme of ["light", "dark"]) {
    const opt = await b.context.newPage();
    await opt.emulateMedia({ colorScheme: scheme });
    await opt.setViewportSize({ width: 900, height: 1100 });
    await opt.goto(`chrome-extension://${b.id}/options/languages.html`);
    await opt.waitForSelector("#available table", { timeout: 20000 });
    await opt.screenshot({ path: `${OUT}/shot-languages-${scheme}.png` });
    await opt.close();
  }
  const phone = await b.context.newPage();
  await phone.setViewportSize({ width: 390, height: 900 });
  await phone.goto(`chrome-extension://${b.id}/options/languages.html`);
  await phone.waitForSelector("#available table", { timeout: 20000 });
  await phone.screenshot({ path: `${OUT}/shot-languages-narrow.png` });
  console.log("screenshots in", OUT);
} finally {
  await b.close();
  srv.close();
}
