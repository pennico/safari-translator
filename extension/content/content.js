/* Page translation, the selection bubble and the small status note. Runs in every frame (all_frames).
 *
 * How a page is translated
 *  1. Collect "units": runs of text and inline elements (links, bold …) inside a block element. Each unit is one
 *     message for the engine; a unit with markup is sent in Bergamot's HTML mode with every inline element replaced
 *     by <span data-t="N"> (opaque bits such as <code> or <img> by <kbd>/<img data-t="N">), so the engine keeps
 *     them in place. The engine's output is parsed by our own small parser: no innerHTML, nothing from the engine is
 *     ever turned into markup.
 *  2. Units are sorted by position: the visible screen first (top to bottom), then below, then above, then hidden.
 *  3. Results are applied *in place*: existing text nodes get new text, elements stay where they are (they are only
 *     moved when the translation reorders them and none of them holds state). Event listeners, framework
 *     references, iframes and videos are untouched.
 *  4. Every change is recorded, so "Show original" puts back the exact text nodes, values and order.
 *  5. A MutationObserver translates text the page adds later (infinite scroll, single-page apps).
 */
(() => {
  "use strict";
  if (globalThis.__stTranslatorLoaded) return;
  globalThis.__stTranslatorLoaded = true;

  const IS_TOP = (() => { try { return window.top === window; } catch { return false; } })();
  const TEXT = 3, ELEM = 1, COMMENT = 8;
  const LETTER = /\p{L}/u;
  const WS = /[ \t\n\r\f]+/g; // HTML whitespace; keeps U+00A0
  const ATTRS = ["title", "alt", "placeholder", "aria-label"];

  // Content never translated (kept as is). Inline ones stay in the sentence as placeholders.
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "code", "pre", "kbd", "samp", "var", "textarea",
    "input", "select", "option", "optgroup", "datalist", "svg", "math", "canvas", "video", "audio", "iframe", "frame",
    "frameset", "object", "embed", "img", "picture", "source", "track", "map", "area", "head", "meta", "link", "base",
    "title", "br", "wbr", "hr", "slot", "param", "ruby", "safari-translator-ui"]);
  const INLINE_TAGS = new Set(["a", "abbr", "acronym", "b", "bdi", "bdo", "big", "cite", "data", "del", "dfn", "em",
    "font", "i", "ins", "label", "mark", "nobr", "q", "s", "small", "span", "strike", "strong", "sub", "sup", "time",
    "tt", "u", "output"]);
  // Moving these would reload/pause/reset them; a unit holding one is never reordered.
  const STATEFUL = new Set(["iframe", "frame", "video", "audio", "object", "embed", "canvas", "input", "select",
    "textarea", "button"]);

  /* ---------------- state ---------------- */
  const S = {
    active: false, from: null, to: null, gen: 0,
    queue: [], inflight: 0, applied: [], // jobs applied, in order (restored in reverse)
    detected: null, chipOk: true, observing: false,
    stats: null, firstScreen: null,
  };
  const ours = new WeakMap(); // text node -> value we put there
  const pending = new WeakSet(); // text nodes waiting for a translation
  const oursAttr = new WeakMap(); // element -> { attr: value we set }
  const retries = new WeakMap(); // container -> times re-translated because the page changed it

  /* ---------------- classification ---------------- */
  let kinds = new WeakMap(); // reset for each pass (styles and DOM change)

  function isSkipped(el) {
    if (SKIP_TAGS.has(el.localName)) return true;
    if (el.getAttribute("translate") === "no") return true;
    if (el.classList && el.classList.contains("notranslate")) return true;
    const ce = el.getAttribute("contenteditable");
    if (ce !== null && ce !== "false") return true;
    if (S.to && el !== document.documentElement && el.hasAttribute("lang") && normLang(el.getAttribute("lang")) === S.to) return true;
    return false;
  }

  /** "inline" (pure inline: translate inside, keep in the sentence), "opaque" (inline, kept as is), "ignore"
   *  (invisible, stays where it is), "block" (own units inside), "skip" (block, never translated). */
  function kind(el) {
    let k = kinds.get(el);
    if (k) return k;
    k = computeKind(el);
    kinds.set(el, k);
    return k;
  }

  function computeKind(el) {
    const name = el.localName;
    let d;
    try { d = getComputedStyle(el).display; } catch { d = ""; }
    if (isSkipped(el)) {
      if (d === "none" && name !== "br" && name !== "wbr") return "ignore";
      return d.startsWith("inline") || name === "br" || name === "wbr" || name === "img" ? "opaque" : "skip";
    }
    if (d === "none" || d === "") d = INLINE_TAGS.has(name) ? "inline" : "block";
    if (!d.startsWith("inline")) return "block";
    if (el.shadowRoot) return "opaque";
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      const ck = kind(c);
      if (ck === "block" || ck === "skip") return "block";
    }
    return "inline";
  }

  function hasLetters(nodes) {
    for (const n of nodes) {
      if (n.nodeType === TEXT) { if (LETTER.test(n.nodeValue)) return true; }
      else if (n.nodeType === ELEM && kind(n) === "inline" && hasLetters(n.childNodes)) return true;
    }
    return false;
  }

  /* ---------------- collecting units ---------------- */
  function collect(root, out) {
    let run = [];
    const flush = () => { if (run.length) { makeUnit(root, run, out); run = []; } };
    for (let c = root.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === TEXT || c.nodeType === COMMENT) run.push(c);
      else if (c.nodeType === ELEM) {
        const k = kind(c);
        if (k === "inline" || k === "opaque" || k === "ignore") run.push(c);
        else { flush(); if (k === "block") collect(c, out); }
      }
    }
    flush();
  }

  function trimmable(n) {
    return n.nodeType === COMMENT || (n.nodeType === TEXT && !n.nodeValue.trim()) || (n.nodeType === ELEM && kinds.get(n) === "ignore");
  }

  function makeUnit(parent, run, out) {
    let a = 0, b = run.length - 1;
    while (a <= b && trimmable(run[a])) a++;
    while (b >= a && trimmable(run[b])) b--;
    if (a > b) return;
    const nodes = run.slice(a, b + 1);
    if (!hasLetters(nodes)) return;
    out.push({ kind: "unit", parent, nodes });
  }

  /** Attribute jobs (title, alt, placeholder, aria-label) inside root. */
  function collectAttrs(root, out) {
    const els = root.querySelectorAll ? root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(",")) : [];
    const list = root.nodeType === ELEM && ATTRS.some((a) => root.hasAttribute(a)) ? [root, ...els] : els;
    for (const el of list) {
      if (el.closest("[translate=no],.notranslate,safari-translator-ui")) continue;
      for (const name of ATTRS) {
        const v = el.getAttribute(name);
        if (!v || v.length > 500 || !LETTER.test(v) || /^(https?:|www\.|\/)/.test(v)) continue;
        const mine = oursAttr.get(el);
        if (mine && mine[name] === v) continue;
        out.push({ kind: "attr", el, name, source: v.replace(WS, " ").trim() });
      }
    }
  }

  /* ---------------- serialising a unit ---------------- */
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function prepareUnit(job) {
    const pre = (() => { try { return /^(pre|break-spaces)/.test(getComputedStyle(job.parent).whiteSpace); } catch { return false; } })();
    job.pre = pre;
    const norm = (s) => (pre ? s : s.replace(WS, " "));
    job.check = []; // [node, value] for every text node, to see if the page changed it before we apply
    const nodes = job.nodes;
    if (nodes.length === 1 && nodes[0].nodeType === TEXT) {
      job.mode = "text";
      job.source = norm(nodes[0].nodeValue);
      job.check.push([nodes[0], nodes[0].nodeValue]);
      job.html = false;
      return;
    }
    job.mode = "html";
    job.html = true;
    job.kindOf = new Map(); // node -> kind when sent (the shared cache is reset by later passes)
    const ids = [];
    const parentOf = [];
    job.levels = []; // { el (null = top), children: [...] }
    const ser = (list, pid) => {
      let s = "";
      for (const n of list) {
        if (n.nodeType === TEXT) { s += esc(norm(n.nodeValue)); job.check.push([n, n.nodeValue]); continue; }
        if (n.nodeType !== ELEM) continue;
        const k = kind(n);
        job.kindOf.set(n, k);
        if (k === "ignore") continue;
        const id = ids.push(n) - 1;
        parentOf[id] = pid;
        if (k === "opaque") {
          const name = n.localName;
          if (name === "br" || name === "wbr") s += `<${name} data-t="${id}">`;
          else if (n.textContent.trim()) s += `<kbd data-t="${id}">${esc(n.textContent.replace(WS, " ").slice(0, 200))}</kbd>`;
          else s += `<img data-t="${id}">`;
        } else {
          const children = Array.from(n.childNodes);
          job.levels.push({ el: n, id, children });
          s += `<span data-t="${id}">${ser(children, id)}</span>`;
        }
      }
      return s;
    };
    job.source = ser(nodes, -1);
    job.ids = ids;
    job.parentOf = parentOf;
  }

  /* ---------------- parsing the engine's HTML (our own tags only) ---------------- */
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(cp); } catch { return m; }
      }
      return ENT[e.toLowerCase()] ?? m;
    });
  }

  /** -> { kids: [ "text" | { id, kids } ] } */
  function parseOut(html) {
    const root = { kids: [] };
    const stack = [root];
    const re = /<(\/?)([a-zA-Z]+)([^<>]*)>|([^<]+)|(<)/g;
    let m;
    const addText = (t) => {
      const kids = stack[stack.length - 1].kids;
      if (typeof kids[kids.length - 1] === "string") kids[kids.length - 1] += t; else kids.push(t);
    };
    while ((m = re.exec(html))) {
      if (m[4] != null) { addText(decode(m[4])); continue; }
      if (m[5] != null) { addText("<"); continue; }
      const closing = m[1] === "/", tag = m[2].toLowerCase();
      if (closing) {
        if ((tag === "span" || tag === "kbd") && stack.length > 1) stack.pop();
        continue;
      }
      const idm = /data-t="(\d+)"/.exec(m[3]);
      if (!idm) continue;
      const node = { id: +idm[1], kids: [] };
      stack[stack.length - 1].kids.push(node);
      if (tag === "span" || tag === "kbd") stack.push(node);
    }
    mergeDuplicates(root.kids);
    return root;
  }

  // Bergamot sometimes splits one tag in two when the words it covered end up apart:
  //   "in <span data-t="0">the cookie</span> policy<span data-t="0">.</span>"
  // Pieces of the same element on one level become one element again when only text lies between them
  // ("<span>the cookie policy.</span>"); otherwise the later pieces are unwrapped into plain text.
  function mergeDuplicates(kids) {
    for (const k of kids) if (typeof k !== "string") mergeDuplicates(k.kids);
    const seen = new Map();
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (typeof k === "string") continue;
      if (!seen.has(k.id)) { seen.set(k.id, i); continue; }
      const first = seen.get(k.id);
      const between = kids.slice(first + 1, i);
      if (between.every((x) => typeof x === "string" || x.id === k.id)) {
        const merged = { id: k.id, kids: [] };
        for (const x of kids.slice(first, i + 1)) merged.kids.push(...(typeof x === "string" ? [x] : x.kids));
        kids.splice(first, i - first + 1, merged);
        i = first;
      } else {
        kids.splice(i, 1, ...k.kids);
        i--;
      }
    }
    // join neighbouring strings
    for (let i = kids.length - 1; i > 0; i--) {
      if (typeof kids[i] === "string" && typeof kids[i - 1] === "string") { kids[i - 1] += kids[i]; kids.splice(i, 1); }
    }
    for (const k of kids) if (typeof k !== "string") {
      for (let i = k.kids.length - 1; i > 0; i--) {
        if (typeof k.kids[i] === "string" && typeof k.kids[i - 1] === "string") { k.kids[i - 1] += k.kids[i]; k.kids.splice(i, 1); }
      }
    }
  }

  /* ---------------- applying ---------------- */
  function stillValid(job) {
    if (job.kind === "attr") return job.el.isConnected && job.el.getAttribute(job.name) != null;
    if (job.kind === "title") return true;
    if (!job.parent.isConnected) return false;
    for (let i = 0; i < job.nodes.length; i++) {
      if (job.nodes[i].parentNode !== job.parent) return false;
      if (i && job.nodes[i - 1].nextSibling !== job.nodes[i]) return false;
    }
    for (const [n, v] of job.check) if (n.nodeValue !== v) return false;
    if (job.levels) for (const lv of job.levels) {
      const cur = lv.el.childNodes;
      if (cur.length !== lv.children.length) return false;
      for (let i = 0; i < cur.length; i++) if (cur[i] !== lv.children[i]) return false;
    }
    return true;
  }

  function setText(job, node, value) {
    const rec = job.changes.texts.get(node);
    if (rec) rec.set = value; else job.changes.texts.set(node, { orig: node.nodeValue, set: value });
    if (node.nodeValue !== value) node.nodeValue = value;
    ours.set(node, value);
  }

  function newText(job, value) {
    const t = document.createTextNode(value);
    job.changes.created.push(t);
    ours.set(t, value);
    return t;
  }

  /** Returns true when applied, "fallback" when the unit must be translated text node by text node. */
  function applyUnit(job, out) {
    job.changes = { texts: new Map(), created: [], reordered: [] };
    if (job.mode === "text" || job.mode === "nodes") {
      if (job.mode === "text") setText(job, job.nodes[0], out);
      else job.textNodes.forEach((n, i) => setText(job, n, out[i]));
      return true;
    }
    const tree = parseOut(out);
    // Check the structure: every id once, under its original parent.
    const seen = new Set();
    let ok = true;
    const walk = (kids, pid) => {
      for (const k of kids) {
        if (typeof k === "string") continue;
        if (k.id >= job.ids.length || seen.has(k.id) || job.parentOf[k.id] !== pid) { ok = false; return; }
        seen.add(k.id);
        if (job.kindOf.get(job.ids[k.id]) !== "opaque") walk(k.kids, k.id);
      }
    };
    walk(tree.kids, -1);
    if (!ok || seen.size !== job.ids.length) return "fallback";
    // An element that had words but comes back empty (e.g. "<a></a>the article") would vanish (a link you can't
    // click): translate this unit text node by text node instead.
    const hasWords = (kids) => kids.some((k) => (typeof k === "string" ? LETTER.test(k) : hasWords(k.kids)));
    const emptied = (kids) => kids.some((k) => typeof k !== "string" && job.kindOf.get(job.ids[k.id]) === "inline"
      && LETTER.test(job.ids[k.id].textContent) && (!hasWords(k.kids) || emptied(k.kids)));
    if (emptied(tree.kids)) return "fallback";
    // Top level, then each inline element.
    const levels = [{ el: null, id: -1, children: job.nodes, items: tree.kids }];
    const itemsById = new Map();
    const index = (kids) => { for (const k of kids) if (typeof k !== "string") { itemsById.set(k.id, k); index(k.kids); } };
    index(tree.kids);
    for (const lv of job.levels) levels.push({ ...lv, items: itemsById.get(lv.id).kids });
    // Decide first (no partial changes), then change.
    const plans = [];
    for (const lv of levels) {
      const origIds = lv.children.filter((n) => n.nodeType === ELEM && job.kindOf.get(n) !== "ignore").map((n) => job.ids.indexOf(n));
      const newIds = lv.items.filter((k) => typeof k !== "string").map((k) => k.id);
      const same = origIds.length === newIds.length && origIds.every((id, i) => id === newIds[i]);
      if (!same) {
        const blocked = lv.children.some((n) => n.nodeType === COMMENT || (n.nodeType === ELEM &&
          (job.kindOf.get(n) === "ignore" || STATEFUL.has(n.localName) || n.localName.includes("-") || n.shadowRoot ||
           (n.querySelector && n.querySelector("iframe,video,audio,object,embed,canvas,input,select,textarea")))));
        if (blocked) return "fallback";
      }
      plans.push({ lv, same });
    }
    for (const { lv, same } of plans) (same ? applyInPlace : applyReorder)(job, lv);
    return true;
  }

  // Same element order: only text changes. Text between two elements goes into the first original text node of
  // that gap (others are emptied but stay, so frameworks holding them keep working).
  function applyInPlace(job, lv) {
    const P = lv.el || job.parent;
    const gapsOrig = [[]];
    const bounds = [];
    for (const n of lv.children) {
      if (n.nodeType === ELEM && job.kindOf.get(n) !== "ignore") { bounds.push(n); gapsOrig.push([]); }
      else if (n.nodeType === TEXT) gapsOrig[gapsOrig.length - 1].push(n);
    }
    const gapsNew = [""];
    for (const k of lv.items) {
      if (typeof k === "string") gapsNew[gapsNew.length - 1] += k; else gapsNew.push("");
    }
    const after = lv.el ? null : job.nodes[job.nodes.length - 1].nextSibling;
    for (let g = 0; g < gapsOrig.length; g++) {
      const olds = gapsOrig[g];
      const text = keepEdges(olds.map((n) => n.nodeValue).join(""), gapsNew[g] || "", g > 0, g < bounds.length);
      if (olds.length) {
        setText(job, olds[0], text);
        for (let i = 1; i < olds.length; i++) setText(job, olds[i], "");
      } else if (text) {
        const ref = g < bounds.length ? bounds[g] : (lv.el ? null : after);
        P.insertBefore(newText(job, text), ref && ref.parentNode === P ? ref : null);
      }
    }
  }

  // The engine sometimes drops the space next to a tag ("<code>x</code>in the app"). Keep the original gap's
  // leading/trailing space where it touches an element, so words don't run into links, code or images.
  function keepEdges(orig, text, afterEl, beforeEl) {
    if (!text.trim()) return text;
    if (afterEl && /^\s/.test(orig) && !/^\s/.test(text)) text = " " + text;
    if (beforeEl && /\s$/.test(orig) && !/\s$/.test(text)) text += " ";
    return text;
  }

  // Different order (allowed only without stateful nodes): rebuild this level from the same nodes.
  function applyReorder(job, lv) {
    const P = lv.el || job.parent;
    const texts = lv.children.filter((n) => n.nodeType === TEXT);
    const seq = [];
    let ti = 0;
    for (const k of lv.items) {
      if (typeof k === "string") seq.push(ti < texts.length ? (setText(job, texts[ti], k), texts[ti++]) : newText(job, k));
      else seq.push(job.ids[k.id]);
    }
    for (; ti < texts.length; ti++) { setText(job, texts[ti], ""); seq.push(texts[ti]); }
    const anchor = lv.el ? null : job.nodes[job.nodes.length - 1].nextSibling;
    job.changes.reordered.push({ parent: P, nodes: lv.children.slice(), anchor });
    for (const n of seq) P.insertBefore(n, anchor && anchor.parentNode === P ? anchor : null);
  }

  function restoreJob(job) {
    if (job.kind === "attr") {
      if (job.el.getAttribute(job.name) === job.set) job.el.setAttribute(job.name, job.orig);
      const m = oursAttr.get(job.el);
      if (m) delete m[job.name];
      return;
    }
    if (job.kind === "title") {
      if (document.title === job.set) document.title = job.orig;
      return;
    }
    const ch = job.changes;
    if (!ch) return;
    for (let i = ch.reordered.length - 1; i >= 0; i--) {
      const { parent, nodes, anchor } = ch.reordered[i];
      for (const n of nodes) parent.insertBefore(n, anchor && anchor.parentNode === parent ? anchor : null);
    }
    for (const [node, { orig, set }] of ch.texts) {
      if (node.nodeValue === set) node.nodeValue = orig;
      ours.delete(node);
    }
    for (const t of ch.created) t.remove();
  }

  /* ---------------- scheduling ---------------- */
  function words(s) { return (s.match(/\S+/g) || []).length; }

  function prioritise(jobs) {
    const vh = innerHeight || 800, vw = innerWidth || 1200;
    const range = document.createRange();
    for (const j of jobs) {
      let r;
      try {
        if (j.kind === "unit") { range.setStartBefore(j.nodes[0]); range.setEndAfter(j.nodes[j.nodes.length - 1]); r = range.getBoundingClientRect(); }
        else if (j.kind === "attr") r = j.el.getBoundingClientRect();
      } catch { r = null; }
      if (j.kind === "title") { j.prio = -1; j.visible = true; continue; }
      if (!r || (r.width === 0 && r.height === 0)) { j.prio = 1e9; j.visible = false; continue; }
      const visible = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      j.visible = visible;
      j.prio = visible ? r.top : r.top >= vh ? vh + (r.top - vh) : 3 * vh - r.bottom;
      if (j.kind === "attr") j.prio += visible ? vh / 2 : vh; // text before tooltips
    }
  }

  function enqueue(jobs, { first = false } = {}) {
    for (const j of jobs) {
      if (j.kind === "unit") {
        prepareUnit(j);
        for (const [n] of j.check) pending.add(n);
      }
    }
    prioritise(jobs);
    if (first) {
      S.firstScreen = new Set(jobs.filter((j) => j.visible));
      S.stats.visibleJobs = S.firstScreen.size;
      S.stats.visibleWords = [...S.firstScreen].reduce((n, j) => n + words(j.source), 0);
    }
    S.queue.push(...jobs);
    S.queue.sort((a, b) => a.prio - b.prio);
    pump();
  }

  function takeBatch() {
    // First batch: the visible screen in one engine call (up to ~350 words), so it appears at once; then bigger
    // batches for throughput.
    let limit = S.stats.batches === 0 ? 150 : S.stats.batches === 1 ? 400 : 800;
    if (S.stats.batches === 0 && S.firstScreen && S.firstScreen.size) {
      let w = 0;
      for (const j of S.firstScreen) w += words(j.source);
      limit = Math.min(350, Math.max(150, w));
    }
    const batch = [];
    let n = 0;
    // Retries of visible text (prio < 0) go out alone, so they don't wait behind a big batch.
    if (S.queue.length && S.queue[0].prio < 0 && S.queue[0].kind !== "title") {
      while (S.queue.length && S.queue[0].prio < 0) batch.push(S.queue.shift());
      return batch;
    }
    while (S.queue.length && (batch.length === 0 || (n < limit && batch.length < 120))) {
      const j = S.queue.shift();
      n += words(j.source);
      batch.push(j);
    }
    return batch;
  }

  function pump() {
    if (!S.active) return;
    // One request at a time until the visible screen is done (a retry must not wait behind a big batch), then two
    // (the next batch waits in the engine while we apply the last one).
    const depth = S.firstScreen && S.firstScreen.size ? 1 : 2;
    while (S.inflight < depth && S.queue.length) {
      const batch = takeBatch();
      S.stats.batches++;
      S.inflight++;
      runBatch(batch, S.gen).finally(() => { S.inflight--; pump(); });
    }
    if (!S.inflight && !S.queue.length && S.stats && !S.stats.doneAt) {
      S.stats.doneAt = performance.now();
      setState("translated");
      if (IS_TOP && S.chipOk && S.stats.manual !== false) chip.done();
    }
  }

  async function runBatch(batch, gen) {
    const items = [], offs = [];
    for (const j of batch) {
      offs.push(items.length);
      if (j.multi) for (const t of j.multi) items.push({ text: t, html: false });
      else items.push({ text: j.source, html: !!j.html });
    }
    let res;
    try {
      await ensurePrepared();
      if (gen !== S.gen) return;
      res = await engineCall("translate", { from: S.from, to: S.to, items });
    } catch (e) {
      if (gen !== S.gen) return;
      fail(e);
      return;
    }
    if (gen !== S.gen) return;
    S.stats.engineMs += res.ms || 0;
    S.stats.words += items.reduce((s, i) => s + words(i.text), 0);
    const redo = [];
    const ta = performance.now();
    withoutObserver(() => {
      for (let i = 0; i < batch.length; i++) {
        const job = batch[i];
        if (job.check) for (const [n] of job.check) pending.delete(n);
        const first = S.firstScreen && S.firstScreen.delete(job);
        const out = job.multi ? res.texts.slice(offs[i], offs[i] + job.multi.length) : res.texts[offs[i]];
        if (!stillValid(job)) { if (job.kind === "unit") markDirty(job.parent); }
        else if (job.kind === "attr") {
          job.orig = job.el.getAttribute(job.name);
          job.set = out.trim();
          job.el.setAttribute(job.name, job.set);
          const m = oursAttr.get(job.el) || {};
          m[job.name] = job.set;
          oursAttr.set(job.el, m);
          S.applied.push(job);
        } else if (job.kind === "title") {
          job.orig = document.title;
          job.set = out.trim();
          document.title = job.set;
          S.applied.push(job);
        } else if (applyUnit(job, out) === "fallback") {
          if ((S.stats.fallbackSamples ||= []).length < 5) S.stats.fallbackSamples.push({ source: job.source.slice(0, 600), out: String(out).slice(0, 600) });
          const sub = toNodesJob(job);
          redo.push(sub);
          if (first) S.firstScreen.add(sub);
          continue;
        } else S.applied.push(job);
        if (first && !S.firstScreen.size && !S.stats.firstScreenAt) {
          S.stats.firstScreenAt = performance.now();
          S.stats.lastVisible = { kind: job.kind, prio: Math.round(job.prio), source: String(job.source).slice(0, 80), batch: S.stats.batches };
        }
      }
    });
    S.stats.applyMs += performance.now() - ta;
    if (!S.stats.firstBatchAt) S.stats.firstBatchAt = performance.now();
    if (redo.length) {
      S.stats.fallbacks += redo.length;
      for (const j of redo) { j.prio = -0.5; S.queue.unshift(j); }
    }
  }

  // Engine dropped or moved a tag: translate this unit's text nodes one by one instead (structure stays exact).
  // Batched as a single engine item with a separator would mix contexts, so each text node is its own message.
  function toNodesJob(job) {
    const textNodes = [];
    const walk = (list) => {
      for (const n of list) {
        if (n.nodeType === TEXT) { if (LETTER.test(n.nodeValue)) textNodes.push(n); }
        else if (n.nodeType === ELEM && job.kindOf.get(n) === "inline") walk(n.childNodes);
      }
    };
    walk(job.nodes);
    const norm = (s) => (job.pre ? s : s.replace(WS, " "));
    const multi = textNodes.map((n) => norm(n.nodeValue));
    for (const n of textNodes) pending.add(n);
    return { kind: "unit", mode: "nodes", parent: job.parent, nodes: job.nodes, textNodes, multi, source: multi.join(" "),
      check: textNodes.map((n) => [n, n.nodeValue]), prio: job.prio, visible: job.visible };
  }

  /* ---------------- start / restore ---------------- */
  // The models are downloaded/loaded once per translation, when the first text needs them (a frame with nothing
  // to translate never asks).
  function ensurePrepared() {
    if (!S.prepared) {
      const gen = S.gen, t0 = performance.now();
      S.prepared = engineLong("prepare", { from: S.from, to: S.to }, onProgress)
        .then(() => { if (S.stats) S.stats.prepareMs = Math.round(performance.now() - t0); })
        .catch((e) => { if (gen === S.gen) fail(e); throw e; });
    }
    return S.prepared;
  }

  function startTranslation(from, to, { manual = true } = {}) {
    if (S.active && S.from === from && S.to === to) return;
    if (S.active) restore({ report: false });
    if (!document.body) return;
    if (IS_TOP && !S.active) detectPage().catch(() => {}); // samples the original text before we change it
    S.active = true; S.from = from; S.to = to; S.gen++;
    S.prepared = null;
    const gen = S.gen;
    S.queue = []; S.applied = [];
    S.stats = { startedAt: performance.now(), firstScreenAt: null, doneAt: null, words: 0, engineMs: 0, batches: 0,
      fallbacks: 0, units: 0, manual, prepareMs: 0, applyMs: 0, firstBatchAt: null };
    setState("translating");
    kinds = new WeakMap();
    const jobs = [];
    collect(document.body, jobs);
    collectAttrs(document.body, jobs);
    if (IS_TOP && document.title && LETTER.test(document.title)) jobs.push({ kind: "title", source: document.title });
    S.stats.units = jobs.length;
    S.stats.collectMs = Math.round(performance.now() - S.stats.startedAt);
    startObserver();
    if (!jobs.length) { pump(); return; }
    if (IS_TOP) setTimeout(() => { if (S.gen === gen && S.active && !S.stats.firstScreenAt && !chipBusy) chip.working(); }, 700);
    enqueue(jobs, { first: true });
  }

  function restore({ report = true } = {}) {
    stopObserver();
    S.gen++;
    S.active = false;
    S.queue = [];
    S.prepared = null;
    chipBusy = false;
    clearTimeout(dirtyTimer); dirtyTimer = 0; dirty.clear();
    withoutObserver(() => {
      for (let i = S.applied.length - 1; i >= 0; i--) {
        try { restoreJob(S.applied[i]); } catch (e) { console.warn("[translator] restore", e); }
      }
    });
    S.applied = [];
    if (report) setState("idle");
    chip.hide();
  }

  function fail(e) {
    const msg = String(e && e.message || e);
    console.warn("[translator]", msg);
    restore({ report: false });
    setState("error");
    if (IS_TOP) chip.error(msg);
  }

  function setState(state) {
    if (!IS_TOP) return;
    S.state = state;
    bg({ type: "state", state, from: S.from, to: S.to }).catch(() => {});
  }

  /* ---------------- watching the page ---------------- */
  const mo = new MutationObserver((recs) => onMutations(recs));
  const dirty = new Set();
  let dirtyTimer = 0, dirtySince = 0, titleDirty = false;

  function startObserver() {
    if (S.observing) return;
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    S.observing = true;
  }
  function stopObserver() { mo.disconnect(); S.observing = false; }

  function withoutObserver(fn) {
    if (S.observing) onMutations(mo.takeRecords());
    try { fn(); } finally { if (S.observing) mo.takeRecords(); }
  }

  function onMutations(recs) {
    if (!S.active || !recs.length) return;
    for (const r of recs) {
      const t = r.target;
      if (r.type === "characterData") {
        const p = t.parentNode;
        if (!p) continue;
        if (p.localName === "title") { titleDirty = true; continue; }
        if (ours.get(t) === t.nodeValue) continue;
        if (ours.has(t)) { // the page rewrote text we translated; don't fight a page that keeps doing it
          const c = (retries.get(p) || 0) + 1;
          retries.set(p, c);
          if (c > 5) continue;
        }
        markDirty(p);
        continue;
      }
      if (t.localName === "title") { titleDirty = true; continue; }
      if (t === uiHost || (document.head && document.head.contains(t))) continue;
      for (const n of r.addedNodes) {
        if (n.nodeType === TEXT) { if (ours.get(n) !== n.nodeValue && LETTER.test(n.nodeValue)) markDirty(t); }
        else if (n.nodeType === ELEM && n !== uiHost) markDirty(n);
      }
    }
    if ((dirty.size || titleDirty) && !dirtyTimer) {
      dirtySince = dirtySince || performance.now();
      dirtyTimer = setTimeout(flushDirty, 150);
    }
  }

  function markDirty(node) {
    if (!node || !S.active) return;
    dirty.add(node);
    if (!dirtyTimer) { dirtySince = performance.now(); dirtyTimer = setTimeout(flushDirty, 150); }
  }

  function flushDirty() {
    dirtyTimer = 0; dirtySince = 0;
    if (!S.active) { dirty.clear(); return; }
    kinds = new WeakMap();
    // Climb to the block that holds each change; drop ones inside others.
    const roots = new Set();
    for (let n of dirty) {
      if (n.nodeType !== ELEM) n = n.parentNode;
      let ok = true;
      for (let p = n; p && p !== document.documentElement; p = p.parentNode) {
        if (p.nodeType !== ELEM) { ok = false; break; } // detached or in a shadow tree
        if (isSkipped(p) || p === uiHost) { ok = false; break; }
      }
      if (!ok || !n || !n.isConnected) continue;
      while (n !== document.body && n.parentNode && n.parentNode.nodeType === ELEM && kind(n) !== "block") n = n.parentNode;
      roots.add(n);
    }
    dirty.clear();
    const list = [...roots].filter((r) => ![...roots].some((o) => o !== r && o.contains(r)));
    const jobs = [];
    for (const r of list) {
      const found = [];
      if (r === document.body || kind(r) === "block") collect(r, found); else collect(r.parentNode, found);
      for (const u of found) {
        // Skip units that are only our own output or already waiting.
        let fresh = false;
        const scan = (list2) => {
          for (const n of list2) {
            if (n.nodeType === TEXT) {
              if (pending.has(n)) { fresh = false; return true; }
              if (LETTER.test(n.nodeValue) && ours.get(n) !== n.nodeValue) fresh = true;
            } else if (n.nodeType === ELEM && kind(n) === "inline" && scan(n.childNodes)) return true;
          }
          return false;
        };
        if (!scan(u.nodes) && fresh) jobs.push(u);
      }
      collectAttrs(r, jobs);
    }
    if (titleDirty && IS_TOP) {
      titleDirty = false;
      const last = S.applied.find((j) => j.kind === "title");
      if (document.title && LETTER.test(document.title) && (!last || document.title !== last.set)) jobs.push({ kind: "title", source: document.title });
    }
    if (jobs.length) {
      if (S.stats.doneAt) S.stats.doneAt = null;
      enqueue(jobs);
    }
  }

  /* ---------------- language of the page ---------------- */
  function pageSample(max = 2500) {
    const parts = [];
    let len = 0;
    if (!document.body) return "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, seen = 0;
    while ((n = walker.nextNode()) && len < max && seen < 4000) {
      seen++;
      const v = n.nodeValue.replace(WS, " ").trim();
      if (v.length < 25 || !LETTER.test(v)) continue;
      const p = n.parentElement;
      if (!p || p.closest("script,style,noscript,template,code,pre,textarea,[translate=no],.notranslate,safari-translator-ui")) continue;
      parts.push(v);
      len += v.length;
    }
    if (len < 200 && document.title) parts.unshift(document.title);
    return parts.join("\n");
  }

  async function detectPage() {
    // While translated, the page shows our output: keep what was found on the original text.
    if (S.detected && (S.detectedUrl === location.href || S.active)) return S.detected;
    if (S.detecting) return S.detecting;
    S.detecting = detectNow().finally(() => { S.detecting = null; });
    return S.detecting;
  }

  async function detectNow() {
    const htmlLang = normLang(document.documentElement.getAttribute("lang"));
    const sample = pageSample();
    let det = { lang: null, confidence: 0, top: [] };
    try { if (sample) det = await engineCall("detect", { text: sample }); } catch (e) { console.warn("[translator] detect", e.message); }
    let lang = det.lang, how = "text";
    if (!(sample.length >= 100 && det.confidence >= 0.6) && htmlLang) { lang = htmlLang; how = "html lang"; }
    S.detected = { lang, confidence: det.confidence, top: det.top, htmlLang, how, sampleLength: sample.length };
    S.detectedUrl = location.href;
    return S.detected;
  }

  /* ---------------- UI: status note and selection bubble ---------------- */
  let uiHost = null, uiRoot = null;
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .w { --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --sunk: #f2f2f5; --accent: #2f6f5b; --on-accent: #fff; --bad: #c2412d;
         font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg); }
    @media (prefers-color-scheme: dark) { .w { --bg: #2c2c2e; --fg: #f5f5f7; --muted: #a1a1a6; --line: #48484a; --sunk: #3a3a3c; --accent: #7cc4a9; --on-accent: #10201a; --bad: #ef7a64; } }
    .chip { position: fixed; right: 16px; bottom: 16px; max-width: min(420px, calc(100vw - 32px)); display: flex; align-items: center; gap: 8px;
            background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; box-shadow: 0 6px 24px rgb(0 0 0 / .18);
            transition: opacity .25s; opacity: 1; pointer-events: auto; }
    .chip.hide { opacity: 0; pointer-events: none; }
    .chip .t { flex: 1; min-width: 0; }
    .chip .bar { height: 3px; background: var(--sunk); border-radius: 2px; margin-top: 5px; overflow: hidden; }
    .chip .bar i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .2s; }
    .err { color: var(--bad); }
    button { font: inherit; color: inherit; background: var(--sunk); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
    button.primary { background: var(--accent); color: var(--on-accent); border-color: transparent; }
    button.x { background: none; border: none; padding: 2px 6px; color: var(--muted); font-size: 15px; line-height: 1; }
    .bubble { position: absolute; width: min(420px, calc(100vw - 24px)); background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
              box-shadow: 0 8px 30px rgb(0 0 0 / .22); pointer-events: auto; }
    .bubble .hd { display: flex; align-items: center; gap: 6px; padding: 7px 8px 6px 10px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    .bubble .hd select { font: inherit; color: var(--fg); background: var(--sunk); border: 1px solid var(--line); border-radius: 6px; padding: 1px 4px; max-width: 150px; }
    .bubble .hd .sp { flex: 1; }
    .bubble .bd { padding: 10px 12px 12px; white-space: pre-wrap; max-height: 50vh; overflow: auto; font-size: 14px; user-select: text; -webkit-user-select: text; }
    .bubble .bd.muted { color: var(--muted); }
  `;

  function ui() {
    if (uiHost && uiHost.isConnected) return uiRoot;
    uiHost = document.createElement("safari-translator-ui");
    uiHost.setAttribute("translate", "no");
    uiHost.style.cssText = "all: initial !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;";
    uiRoot = uiHost.attachShadow({ mode: "closed" });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      uiRoot.adoptedStyleSheets = [sheet];
    } catch {
      const st = document.createElement("style");
      st.textContent = CSS;
      uiRoot.append(st);
    }
    const w = document.createElement("div");
    w.className = "w";
    uiRoot.append(w);
    (document.documentElement).append(uiHost);
    return uiRoot;
  }
  const wrap = () => ui().querySelector(".w");

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === "class") e.className = v;
      else e[k] = v;
    }
    e.append(...kids.filter((k) => k != null));
    return e;
  }

  const chip = (() => {
    let box = null, timer = 0;
    const show = (content, { autoHide = 0 } = {}) => {
      if (!IS_TOP) return;
      clearTimeout(timer);
      if (!box || !box.isConnected) {
        box = el("div", { class: "chip", on: { mouseenter: () => clearTimeout(timer) } });
        wrap().append(box);
      }
      box.classList.remove("hide");
      box.replaceChildren(...content);
      if (autoHide) timer = setTimeout(() => box.classList.add("hide"), autoHide);
    };
    const close = el("button", { class: "x", title: "Close", textContent: "×", on: { click: () => hide() } });
    const hide = () => { clearTimeout(timer); if (box) box.classList.add("hide"); };
    return {
      hide,
      working() { show([el("div", { class: "t", textContent: "Translating…" })]); },
      progress(p) {
        const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
        const bar = el("div", { class: "bar" }, el("i"));
        bar.firstChild.style.width = pct + "%";
        show([el("div", { class: "t" },
          el("div", { textContent: `Downloading ${langNames(p.from)} → ${langNames(p.to)} · ${fmtMB(p.loaded)} of ${fmtMB(p.total)}` }), bar)]);
      },
      done() {
        show([el("div", { class: "t", textContent: `Translated from ${langNames(S.from)}` }),
          el("button", { textContent: "Show original", on: { click: () => { bg({ type: "restoreTab" }).catch(() => restore()); } } }),
          close.cloneNode(true)], { autoHide: 5000 });
        box.lastChild.addEventListener("click", hide);
      },
      notice(text) {
        show([el("div", { class: "t", textContent: text })], { autoHide: 4000 });
      },
      error(text) {
        const x = el("button", { class: "x", title: "Close", textContent: "×", on: { click: () => hide() } });
        show([el("div", { class: "t err", textContent: `Translation failed: ${text}` }), x]);
      },
    };
  })();

  /* ---------------- selection bubble ---------------- */
  let bubble = null;
  let languagesCache = null;

  async function languages() {
    if (!languagesCache) languagesCache = engineCall("languages", {}).catch((e) => { languagesCache = null; throw e; });
    return languagesCache;
  }

  function closeBubble() {
    if (bubble) { bubble.remove(); bubble = null; }
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function outside(e) { if (e.composedPath && !e.composedPath().includes(uiHost)) closeBubble(); }
  function onKey(e) { if (e.key === "Escape") closeBubble(); }

  async function translateSelection(fallbackText) {
    const sel = getSelection();
    const text = ((sel && sel.toString()) || fallbackText || "").trim().slice(0, 5000);
    if (!text) return;
    let rect = null;
    try { if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { /* none */ }
    if (!rect || (!rect.width && !rect.height)) rect = { left: innerWidth / 2 - 200, right: innerWidth / 2 + 200, top: 80, bottom: 100 };
    closeBubble();
    const settings = await getSettings();
    const body = el("div", { class: "bd muted", textContent: "Translating…" });
    const fromSel = el("select", { title: "From" });
    const toSel = el("select", { title: "To" });
    const copy = el("button", { textContent: "Copy", disabled: true });
    const x = el("button", { class: "x", title: "Close (Esc)", textContent: "×", on: { click: closeBubble } });
    bubble = el("div", { class: "bubble" }, el("div", { class: "hd" }, fromSel, el("span", { textContent: "→" }), toSel, el("span", { class: "sp" }), copy, x), body);
    wrap().append(bubble);
    const bw = Math.min(420, innerWidth - 24);
    let left = Math.max(12, Math.min(rect.left, innerWidth - bw - 12)) + scrollX;
    let top = rect.bottom + 8 + scrollY;
    bubble.style.left = left + "px";
    bubble.style.top = top + "px";
    // Flip above the selection when there's no room below.
    requestAnimationFrame(() => {
      if (!bubble) return;
      const h = bubble.getBoundingClientRect().height;
      if (rect.bottom + 8 + h > innerHeight && rect.top - 8 - h > 0) bubble.style.top = (rect.top - 8 - h + scrollY) + "px";
    });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);

    let result = "";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(result); }
      catch {
        const ta = el("textarea", { value: result });
        wrap().append(ta); ta.select(); document.execCommand("copy"); ta.remove();
      }
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1200);
    });

    // Languages
    let det = null;
    try { det = await engineCall("detect", { text }); } catch { /* fall back to the page */ }
    const page = S.from || (S.detected && S.detected.lang);
    let from = det && det.lang && (det.confidence >= 0.5 || !page) ? det.lang : (page || (det && det.lang) || "en");
    let to = settings.target;
    let langs;
    try { langs = await languages(); } catch (e) { body.textContent = e.message; return; }
    const froms = new Set(), tos = new Set([langs.pivot]);
    for (const p of langs.pairs) { if (p.orphan) continue; froms.add(p.from); tos.add(p.to); }
    froms.add(langs.pivot);
    const fill = (s, codes, value) => {
      s.replaceChildren(...[...codes].sort((a, b) => langNames(a).localeCompare(langNames(b))).map((c) => el("option", { value: c, textContent: langNames(c) })));
      s.value = value;
    };
    if (!froms.has(from)) froms.add(from);
    fill(fromSel, froms, from);
    fill(toSel, tos, to);
    const run = async () => {
      from = fromSel.value; to = toSel.value;
      copy.disabled = true;
      if (from === to) { body.className = "bd muted"; body.textContent = `Already in ${langNames(to)}. Pick the language it's in on the left.`; return; }
      body.className = "bd muted";
      body.textContent = "Translating…";
      try {
        bubbleProgress = (p) => { body.textContent = `Downloading ${langNames(p.from)} → ${langNames(p.to)} · ${fmtMB(p.loaded)} of ${fmtMB(p.total)}`; };
        await engineLong("prepare", { from, to }, (p) => bubbleProgress && bubbleProgress(p));
        const paras = text.split(/(\n+)/);
        const items = paras.map((p) => ({ text: /^\n+$/.test(p) ? "" : p, html: false }));
        const res = await engineCall("translate", { from, to, items });
        result = res.texts.map((t, i) => (/^\n+$/.test(paras[i]) ? paras[i] : t)).join("");
        if (!bubble) return;
        body.className = "bd";
        body.textContent = result;
        copy.disabled = false;
      } catch (e) {
        body.className = "bd err";
        body.textContent = e.message;
      } finally { bubbleProgress = null; }
    };
    fromSel.addEventListener("change", run);
    toSel.addEventListener("change", run);
    run();
  }
  let bubbleProgress = null;

  /* ---------------- talking to the background ---------------- */
  let chipBusy = false;
  function onProgress(p) {
    if (bubbleProgress) bubbleProgress(p);
    else if (IS_TOP) { chipBusy = true; chip.progress(p); }
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "status":
        if (!IS_TOP) return false;
        detectPage().then((d) => sendResponse({
          state: S.active ? (S.stats && S.stats.doneAt ? "translated" : "translating") : (S.state === "error" ? "error" : "idle"),
          from: S.from, to: S.to, detected: d, url: location.href, stats: S.stats,
          host: location.hostname,
        }), (e) => sendResponse({ error: e.message }));
        return true;
      case "translate":
        startTranslation(msg.from, msg.to, { manual: msg.manual !== false });
        sendResponse({ ok: true });
        return false;
      case "restore":
        restore();
        sendResponse({ ok: true });
        return false;
      case "translateSelection":
        translateSelection(msg.text);
        sendResponse({ ok: true });
        return false;
      case "notice":
        if (IS_TOP) chip.notice(msg.text);
        sendResponse({ ok: true });
        return false;
      case "progress":
        if (IS_TOP) onProgress(msg);
        return false;
      default:
        return false;
    }
  });

  // On load: translate right away if this site is set to "always" (or, in a sub-frame, if the tab is translated).
  (async () => {
    let hello;
    try { hello = await bg({ type: "hello" }); } catch { return; }
    if (hello.chip === false) S.chipOk = false;
    if (!hello.auto) return;
    if (!IS_TOP) { startTranslation(hello.auto.from, hello.auto.to, { manual: false }); return; }
    const d = await detectPage();
    const from = hello.auto.from && hello.auto.from !== "auto" ? hello.auto.from : d.lang;
    if (!from || from === hello.auto.to) return;
    bg({ type: "translateTab", from, to: hello.auto.to, manual: false }).catch(() => {});
  })();

  // For the tests (they reach the content script's isolated world through DevTools; pages can't see this).
  globalThis.__stTranslatorDebug = {
    state: S, detectPage, restore, startTranslation,
    bubbleText: () => bubble ? bubble.querySelector(".bd").textContent : null,
    bubbleLangs: () => bubble ? [...bubble.querySelectorAll("select")].map((s) => s.value) : null,
    chipText: () => { const c = uiRoot && uiRoot.querySelector(".chip:not(.hide)"); return c ? c.textContent : null; },
  };
})();
