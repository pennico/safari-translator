/* Languages page: settings, models on disk (delete), available models (download). */
"use strict";
const $ = (id) => document.getElementById(id);
let settings = null, langs = null;
const busy = new Map(); // "da-en" -> progress element

function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "class") e.className = v;
    else e[k] = v;
  }
  e.append(...kids.filter((k) => k != null && k !== false));
  return e;
}
const status = (t, cls = "") => { $("status").className = cls; $("status").textContent = t; };
const pairName = (p) => `${langNames(p.from)} → ${langNames(p.to)}`;

async function load(refresh = false) {
  settings = await getSettings();
  try {
    langs = await engineCall("languages", { refresh });
  } catch (e) {
    langs = null;
    status(e.message, "err");
  }
  render();
}

function render() {
  // Settings
  const tos = new Set(["en"]);
  if (langs) for (const p of langs.pairs) if (!p.orphan) tos.add(p.to);
  const target = $("target");
  target.replaceChildren(...[...tos].sort((a, b) => langNames(a).localeCompare(langNames(b)))
    .map((c) => h("option", { value: c, textContent: langNames(c) })));
  target.value = settings.target;
  $("chip").checked = settings.chip !== false;
  const sites = Object.entries(settings.always).sort(([a], [b]) => a.localeCompare(b));
  $("sites").replaceChildren(...(sites.length ? sites.map(([host, v]) => h("div", { class: "row" },
    h("span", { class: "mono", textContent: host }),
    h("span", { class: "muted small", textContent: v.from && v.from !== "auto" ? `from ${langNames(v.from)}` : "language detected" }),
    h("button", { class: "link", textContent: "Remove", on: { click: async () => {
      delete settings.always[host];
      await setSettings({ always: settings.always });
      render();
    } } }))) : [h("span", { class: "muted", textContent: "No sites yet. Tick “Always translate …” in the toolbar popup." })]));
  if (!langs) return;
  $("fetched").textContent = langs.fetchedAt ? new Date(langs.fetchedAt).toLocaleString() : "–";

  // On this Mac
  const inst = langs.pairs.filter((p) => p.installedSize > 0).sort((a, b) => pairName(a).localeCompare(pairName(b)));
  const total = inst.reduce((s, p) => s + p.installedSize, 0);
  $("total").textContent = inst.length ? `· ${fmtMB(total)}` : "";
  $("installed").replaceChildren(inst.length ? h("table", {},
    h("tr", {}, h("th", { textContent: "Direction" }), h("th", { textContent: "Model" }), h("th", { class: "num", textContent: "Size" }), h("th")),
    ...inst.map((p) => h("tr", {},
      h("td", { textContent: pairName(p) }),
      h("td", { class: "muted small", textContent: [p.architecture, p.version && `v${p.version}`, p.partial && "incomplete",
        p.outdated && "newer version available", p.orphan && "no longer offered"].filter(Boolean).join(" · ") }),
      h("td", { class: "num", textContent: fmtMB(p.installedSize) }),
      h("td", { class: "act" }, h("button", { class: "danger", textContent: "Delete", on: { click: () => remove(p) } })))))
    : h("p", { class: "muted", textContent: "No language models yet. The first translation downloads the one it needs." }));

  // Available, grouped by language (each with its two directions to/from English)
  const filter = $("filter").value.trim().toLowerCase();
  const byLang = new Map();
  const other = [];
  for (const p of langs.pairs) {
    if (p.orphan) continue;
    const L = p.from === langs.pivot ? p.to : p.to === langs.pivot ? p.from : null;
    if (!L) { other.push(p); continue; }
    const row = byLang.get(L) || {};
    row[p.from === langs.pivot ? "fromPivot" : "toPivot"] = p;
    byLang.set(L, row);
  }
  const rows = [...byLang.entries()].sort(([a], [b]) => langNames(a).localeCompare(langNames(b)))
    .filter(([L]) => !filter || langNames(L).toLowerCase().includes(filter) || L.includes(filter));
  const cell = (p) => {
    if (!p) return h("td", { class: "act muted small", textContent: "—" });
    const key = `${p.from}-${p.to}`;
    let action;
    if (busy.has(key)) action = busy.get(key);
    else if (p.installed && !p.outdated) action = h("span", { class: "small ok", textContent: "✓ On this Mac" });
    else action = h("button", { title: `${pairName(p)}: ${p.architecture || ""} model, ${fmtMB(p.size)} on disk`,
      on: { click: () => download(p) } },
      h("span", { class: "verb", textContent: `${p.outdated ? "Update" : "Download"} · ` }), h("span", { class: "arrow", textContent: "↓ " }), fmtMB(p.downloadSize));
    return h("td", { class: "act" }, action);
  };
  $("available").replaceChildren(h("table", {},
    h("tr", {}, h("th", { textContent: "Language" }), h("th", { class: "act", textContent: `→ ${langNames(langs.pivot)}` }),
      h("th", { class: "act", textContent: `${langNames(langs.pivot)} →` })),
    ...rows.map(([L, r]) => h("tr", {}, h("td", { textContent: langNames(L) }), cell(r.toPivot), cell(r.fromPivot))),
    ...other.map((p) => h("tr", {}, h("td", { textContent: pairName(p) }), cell(p), h("td")))));
}

async function download(p) {
  const key = `${p.from}-${p.to}`;
  const bar = h("div", { class: "bar", title: "Downloading" }, h("i"));
  busy.set(key, bar);
  render();
  try {
    await engineLong("download", { from: p.from, to: p.to }, (pr) => {
      bar.firstChild.style.width = `${pr.total ? Math.round((pr.loaded / pr.total) * 100) : 0}%`;
      bar.title = `${fmtMB(pr.loaded)} of ${fmtMB(pr.total)}`;
    });
    status(`${pairName(p)} downloaded.`);
  } catch (e) {
    status(`${pairName(p)}: ${e.message}`, "err");
  } finally {
    busy.delete(key);
    await load();
  }
}

async function remove(p) {
  if (!confirm(`Delete ${pairName(p)} (${fmtMB(p.installedSize)})? It downloads again when needed.`)) return;
  try {
    await engineCall("remove", { from: p.from, to: p.to });
    status(`${pairName(p)} deleted.`);
  } catch (e) { status(e.message, "err"); }
  await load();
}

// Speed check: Danish → English on a built-in sample (text written for this test), through the background engine.
const SAMPLE = [
  "Klokken er lidt over seks om morgenen, og på stoppestedet midt i landsbyen står tre personer og venter.",
  "Bussen kommer kun én gang i timen, og hvis man misser den, kommer man for sent på arbejde.",
  "Det er netop den slags rejser, regionens nye trafikplan skal gøre lettere.",
  "Planen lover afgange hver halve time på de vigtigste ruter mellem klokken fem om morgenen og midnat.",
  "Den største post i budgettet er nye busser, og samtidig skal der bygges ladestationer ved endestationerne.",
  "Erfaringerne fra en forsøgsordning i den nordlige del af regionen viser, at flere afgange giver flere passagerer.",
  "I flere af de mindste landsbyer frygter man, at de små ruter bliver erstattet af telebusser, som skal bestilles i forvejen.",
  "Regionen understreger, at ingen ruter bliver nedlagt uden en offentlig høring.",
  "Planen skal finansieres af statslige tilskud, besparelser på administrationen og en mindre stigning i billetpriserne.",
  "Ved fyrre af de største stoppesteder skal der bygges overdækkede cykelparkeringer.",
  "Planen skal nu i høring i otte uger, og alle borgere kan sende deres kommentarer via regionens hjemmeside.",
  "Hvis den bliver vedtaget, vil de første ændringer træde i kraft ved køreplansskiftet i august næste år.",
];
$("speed").addEventListener("click", async () => {
  const out = $("speedOut");
  out.textContent = "running…";
  try {
    let t = performance.now();
    await engineLong("prepare", { from: "da", to: "en" }, (p) => { out.textContent = `downloading Danish → English · ${fmtMB(p.loaded)} of ${fmtMB(p.total)}`; });
    const prep = performance.now() - t;
    const items = SAMPLE.map((text) => ({ text, html: false }));
    const words = SAMPLE.join(" ").split(/\s+/).length;
    const runs = [];
    for (let i = 0; i < 3; i++) { t = performance.now(); await engineCall("translate", { from: "da", to: "en", items }); runs.push(performance.now() - t); }
    const best = Math.min(...runs);
    out.textContent = `model ready in ${(prep / 1000).toFixed(2)} s; ${words} words in ${(runs[0] / 1000).toFixed(2)} s first, `
      + `${(best / 1000).toFixed(2)} s best = ${Math.round(words / (best / 1000))} words/s`;
  } catch (e) { out.textContent = e.message; }
  await load();
});

$("target").addEventListener("change", async () => { settings.target = $("target").value; await setSettings({ target: settings.target }); });
$("chip").addEventListener("change", async () => { settings.chip = $("chip").checked; await setSettings({ chip: settings.chip }); });
$("filter").addEventListener("input", () => render());
$("refresh").addEventListener("click", () => load(true));
load();
