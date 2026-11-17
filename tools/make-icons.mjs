#!/usr/bin/env node
// Renders tools/icon.svg and tools/toolbar.svg to the PNG sizes the manifest and the Xcode app need.
// usage: jstest/run.sh ../tools/make-icons.mjs   (needs jstest/setup.sh once)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(ROOT, "jstest", "package.json"))("playwright"); // jstest's Playwright
const OUT = join(ROOT, "extension/icons");
mkdirSync(OUT, { recursive: true });
const jobs = [
  ...[16, 32, 48, 64, 96, 128, 256, 512].map((s) => ["icon.svg", `icon-${s}.png`, s]),
  ...[16, 19, 32, 38].map((s) => ["toolbar.svg", `toolbar-${s}.png`, s]),
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [svg, name, size] of jobs) {
  const src = readFileSync(join(ROOT, "tools", svg), "utf8");
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${src.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  writeFileSync(join(OUT, name), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log(name);
}
await browser.close();
