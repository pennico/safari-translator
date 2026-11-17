/* Toolbar popup: from → to, Translate / Show original, "Always translate this site", link to Languages. */
"use strict";
const $ = (id) => document.getElementById(id);
const ui = { from: $("from"), to: $("to"), note: $("note"), main: $("main"), always: $("always"),
  alwaysLabel: $("alwaysLabel"), progress: $("progress"), languages: $("languages") };
let tab = null, status = null, langs = null, settings = null, pollTimer = 0, userFrom = null;

function setNote(text, cls = "muted") {
  ui.note.className = `note small ${cls}`;
  ui.note.textContent = text;
}

function options(select, codes, value, extra) {
  const list = [...codes].sort((a, b) => langNames(a).localeCompare(langNames(b)));
  select.replaceChildren(...list.map((c) => {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = langNames(c) + (extra && extra[c] ? extra[c] : "");
    return o;
  }));
  if (value) select.value = value;
}

function routeFor(from, to) {
  if (!langs || langs.error || from === to) return null;
  const pairs = new Map(langs.pairs.filter((p) => !p.orphan).map((p) => [`${p.from}-${p.to}`, p]));
  if (pairs.has(`${from}-${to}`)) return [pairs.get(`${from}-${to}`)];
  const P = langs.pivot;
  if (from !== P && to !== P && pairs.has(`${from}-${P}`) && pairs.has(`${P}-${to}`)) return [pairs.get(`${from}-${P}`), pairs.get(`${P}-${to}`)];
  return null;
}

async function tabStatus() {
  try { return await bg({ type: "tabStatus", tabId: tab.id }); } catch (e) { return { error: e.message }; }
}

function render() {
  const can = status && !status.error;
  const host = can ? status.host : "";
  ui.alwaysLabel.textContent = host ? `Always translate ${host}` : "Always translate this site";
  ui.always.disabled = !host;
  ui.always.checked = !!(host && settings.always[host]);
  if (langs && !langs.error) {
    const froms = new Set([langs.pivot]), tos = new Set([langs.pivot]);
    for (const p of langs.pairs) if (!p.orphan) { froms.add(p.from); tos.add(p.to); }
    const detected = can && status.detected && status.detected.lang;
    const site = host && settings.always[host];
    const from = userFrom || (can && status.from) || (site && site.from !== "auto" && site.from) || detected || "en";
    if (detected) froms.add(detected); // the note line says "Detected …"
    if (!froms.has(from)) froms.add(from);
    options(ui.from, froms, from);
    options(ui.to, tos, (can && status.to && status.state !== "idle" && status.state !== "error") ? status.to : settings.target);
  } else {
    ui.from.replaceChildren(); ui.to.replaceChildren();
  }
  ui.progress.hidden = true;
  if (!can) {
    ui.main.disabled = true;
    ui.main.textContent = "Translate";
    setNote(status && status.error && /Cannot access|cannot be scripted|not allowed|permission|Missing host/i.test(status.error)
      ? "This page can't be translated (browser page, or the site isn't allowed in Safari › Settings › Extensions)."
      : "This page can't be translated.", "muted");
    return;
  }
  if (langs && langs.error) { ui.main.disabled = true; setNote(langs.error, "err"); return; }
  const from = ui.from.value, to = ui.to.value;
  const busy = status.state === "translating", done = status.state === "translated";
  if (busy || done) {
    ui.main.disabled = false;
    ui.main.textContent = "Show original";
    ui.main.className = "wide";
    const st = status.stats;
    const secs = (a, b) => (b && a != null ? `${((b - a) / 1000).toFixed(1)} s` : null);
    const timing = done && st ? [secs(st.startedAt, st.firstScreenAt) && `screen ${secs(st.startedAt, st.firstScreenAt)}`,
      secs(st.startedAt, st.doneAt) && `page ${secs(st.startedAt, st.doneAt)}`].filter(Boolean).join(", ") : "";
    setNote(done ? `Translated from ${langNames(status.from)}${timing ? ` (${timing})` : ""}.` : "Translating…");
    return;
  }
  ui.main.className = "primary wide";
  ui.main.textContent = "Translate";
  const route = routeFor(from, to);
  if (from === to) {
    ui.main.disabled = true;
    ui.main.textContent = `Already in ${langNames(to)}`;
    setNote(`Pick another “From” language if the page isn't in ${langNames(to)}.`);
  } else if (!route) {
    ui.main.disabled = true;
    setNote(`No model for ${langNames(from)} → ${langNames(to)} yet.`);
  } else {
    ui.main.disabled = false;
    const need = route.filter((p) => !p.installed).reduce((s, p) => s + p.downloadSize, 0);
    const via = route.length > 1 ? ` via ${langNames(langs.pivot)}` : "";
    const d = status.detected;
    const what = d && d.lang === from ? `Detected ${langNames(from)}${d.how === "html lang" ? " (page setting)" : ""}` : langNames(from);
    setNote(status.state === "error" ? "The last try failed. Try again." :
      `${what}${via}.${need ? ` Downloads ${fmtMB(need)} the first time.` : ""}`);
  }
}

function poll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    status = await tabStatus();
    render();
    if (status && status.state === "translating") poll();
  }, 400);
}

ui.main.addEventListener("click", async () => {
  ui.main.disabled = true;
  try {
    if (status.state === "translating" || status.state === "translated") {
      await bg({ type: "restoreTab", tabId: tab.id });
    } else {
      await bg({ type: "translateTab", tabId: tab.id, from: ui.from.value, to: ui.to.value });
    }
  } catch (e) { setNote(e.message, "err"); }
  status = await tabStatus();
  render();
  if (status.state === "translating") poll();
});

ui.from.addEventListener("change", async () => {
  userFrom = ui.from.value;
  if (status && (status.state === "translated" || status.state === "translating")) {
    await bg({ type: "translateTab", tabId: tab.id, from: ui.from.value, to: ui.to.value });
    status = await tabStatus();
    poll();
  }
  await saveAlwaysFrom();
  render();
});

ui.to.addEventListener("change", async () => {
  settings.target = ui.to.value;
  await setSettings({ target: settings.target });
  if (status && (status.state === "translated" || status.state === "translating")) {
    await bg({ type: "translateTab", tabId: tab.id, from: ui.from.value, to: ui.to.value });
    status = await tabStatus();
    poll();
  }
  render();
});

async function saveAlwaysFrom() {
  const host = status && status.host;
  if (!host || !settings.always[host]) return;
  const detected = status.detected && status.detected.lang;
  settings.always[host] = { from: ui.from.value === detected ? "auto" : ui.from.value };
  await setSettings({ always: settings.always });
}

ui.always.addEventListener("change", async () => {
  const host = status && status.host;
  if (!host) return;
  if (ui.always.checked) {
    settings.always[host] = { from: "auto" };
    await saveAlwaysFrom();
  } else delete settings.always[host];
  await setSettings({ always: settings.always });
  if (ui.always.checked && status.state === "idle" && !ui.main.disabled) ui.main.click();
});

ui.languages.addEventListener("click", () => { api.runtime.openOptionsPage(); window.close(); });

api.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "progress") return;
  ui.progress.hidden = false;
  ui.progress.firstElementChild.style.width = `${msg.total ? Math.round((msg.loaded / msg.total) * 100) : 0}%`;
  setNote(`Downloading ${langNames(msg.from)} → ${langNames(msg.to)} · ${fmtMB(msg.loaded)} of ${fmtMB(msg.total)}`);
});

(async () => {
  settings = await getSettings();
  const forced = Number(new URLSearchParams(location.search).get("tab")); // tests open the popup as a page
  [tab] = forced ? [{ id: forced }] : await api.tabs.query({ active: true, currentWindow: true });
  const langsP = engineCall("languages", {}).catch((e) => ({ error: e.message }));
  status = tab ? await tabStatus() : { error: "no tab" };
  langs = await langsP;
  render();
  if (status && status.state === "translating") poll();
})();
