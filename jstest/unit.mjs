// Fast checks without a browser: the engine-output parser (content.js) and the model-record rules (engine.js).
// usage: node unit.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`}`);
};

// content.js is one closure; pull the pure functions out by name.
const src = readFileSync(new URL("../extension/content/content.js", import.meta.url), "utf8");
const grab = (name) => {
  const i = src.indexOf(`  function ${name}(`);
  let depth = 0;
  for (let k = src.indexOf("{", i); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && !--depth) return src.slice(i, k + 1);
  }
  throw new Error(`no ${name}`);
};
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const parseOut = new Function("ENT", `${grab("decode")}\n${grab("parseOut")}\n${grab("mergeDuplicates")}\nreturn parseOut;`)(ENT);
const keepEdges = new Function(`${grab("keepEdges")}\nreturn keepEdges;`)();

eq("parse: text and tags", parseOut('Read <span data-t="0">the <span data-t="1">full</span> article</span>.'),
  { kids: ["Read ", { id: 0, kids: ["the ", { id: 1, kids: ["full"] }, " article"] }, "."] });
eq("parse: entities, stray <", parseOut("a &lt; b &amp; c < d &#x2014; &#8364;"), { kids: ["a < b & c < d — €"] });
eq("parse: void and opaque", parseOut('x <img data-t="2"> y <br data-t="3"> <kbd data-t="4">F5</kbd>'),
  { kids: ["x ", { id: 2, kids: [] }, " y ", { id: 3, kids: [] }, " ", { id: 4, kids: ["F5"] }] });
eq("parse: tags without our id are dropped", parseOut("<b>bold</b> text"), { kids: ["bold text"] });
eq("merge: split tag with text between", parseOut('in <span data-t="0">the cookie</span> policy<span data-t="0">.</span> See'),
  { kids: ["in ", { id: 0, kids: ["the cookie policy."] }, " See"] });
eq("merge: split tag around another element is unwrapped", parseOut('<span data-t="0">a</span> <span data-t="1">b</span> <span data-t="0">c</span>'),
  { kids: [{ id: 0, kids: ["a"] }, " ", { id: 1, kids: ["b"] }, " c"] });
eq("edges: space after an element kept", keepEdges(" i appen", "in the app", true, false), " in the app");
eq("edges: space before an element kept", keepEdges("Læs ", "Read", false, true), "Read ");
eq("edges: nothing added at the start of a block", keepEdges("Hej ", "Hello", false, false), "Hello");

const { compareVersions, recordAllowed } = require("../extension/engine/engine.js");
eq("versions: 3.0a1 < 3.0 < 3.1", ["3.1", "3.0", "3.0a1"].sort(compareVersions), ["3.0a1", "3.0", "3.1"]);
eq("records: release desktop filters", ["", "env.appinfo.OS != 'Android'", "env.appinfo.OS == 'Android'", "env.channel == 'default' || env.channel == 'nightly'"]
  .map((f) => recordAllowed({ filter_expression: f })), [true, true, false, false]);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
