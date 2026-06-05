// Report canvas → one standalone HTML file. Self-contained by construction:
// inline CSS (reading-room palette, Fraunces/Plex font STACKS with system
// fallbacks — no font files, no @font-face, no external URL of any kind),
// hand-rolled SVG charts (Tufte-spare: direct labels, no chartjunk), evidence
// drill-down powered by a JSON blob embedded in a script tag and ~40 lines of
// vanilla JS. Ladder marks ◌◑●◉ sit beside every number; anything below
// Corrected renders hollow/hatched; a watermark band appears when any block
// is Exploratory. A print stylesheet makes the same file publication-ready.
import path from "node:path";
import { ConcordError } from "../core/errors.js";
import { readNdjson } from "../core/store.js";
import { generate as generateMethods, generatePreview as previewMethods, loadAnalysis, fmt, LEVEL_MARKS, LEVEL_NAMES } from "./methods.js";

const KINDS = new Set(["chart", "table", "quote", "text", "methods-excerpt"]);

function fail(message, details = {}) {
  throw new ConcordError("VALIDATION", message, details);
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------- data prep

async function loadAllUnits(project, projectDir) {
  const map = new Map();
  for (const c of project.corpora ?? []) {
    const units = await readNdjson(path.join(projectDir, "corpora", c.id, "units.ndjson"));
    for (const u of units) map.set(u.id, u);
  }
  return map;
}

async function loadOutputsByUnit(projectDir, runId, cache) {
  if (cache.has(runId)) return cache.get(runId);
  const rows = await readNdjson(path.join(projectDir, "runs", runId, "outputs.ndjson"));
  const byUnit = new Map();
  for (const o of rows) {
    const prev = byUnit.get(o.unitId);
    if (!prev || o.juror === "aggregate") byUnit.set(o.unitId, o); // aggregate wins
  }
  cache.set(runId, byUnit);
  return byUnit;
}

// Evidence map for the drill-down: cell key → quotes (unit text + the machine
// judgment on that unit). Keys are the analysis's own evidence-cell keys so
// data-evidence attributes match; on (unlikely) key collision across blocks
// the first block wins.
async function evidenceFor(analysis, projectDir, unitsMap, outputsCache, evidence) {
  const cells = analysis.evidence?.cells ?? {};
  const runId = analysis.spec?.runId;
  const byUnit = runId ? await loadOutputsByUnit(projectDir, runId, outputsCache) : new Map();
  for (const [key, ids] of Object.entries(cells)) {
    if (evidence[key]) continue;
    evidence[key] = (ids ?? []).slice(0, 8).map((uid) => {
      const u = unitsMap.get(uid);
      const o = byUnit.get(uid);
      return {
        unitId: uid,
        text: u?.text ?? "",
        label: o?.label ?? null,
        confidence: o?.confidence ?? null,
        rationale: o?.rationale ?? null,
      };
    });
  }
}

// Normalize an analysis (or inline content) into chart/table rows.
function rowsFrom(analysis, content) {
  if (content?.bars) {
    return {
      title: content.title ?? "",
      level: content.level ?? "exploratory",
      rows: content.bars.map((b) => ({
        key: String(b.label), label: String(b.label), value: b.value,
        ciLo: b.ci?.lo, ciHi: b.ci?.hi, naive: b.naive, n: b.n,
      })),
      diff: null,
    };
  }
  const r = analysis?.results ?? {};
  const cells = Array.isArray(r.cells) ? r.cells : [];
  if (cells.length === 0) {
    throw new ConcordError("VALIDATION", "block has no renderable cells", { analysisId: analysis?.id });
  }
  const outcome = r.outcome ?? analysis.spec?.rows ?? "estimate";
  const title = `${outcome}${r.groupBy ? ` by ${r.groupBy}` : ""}`;
  return {
    title,
    level: analysis.level ?? "exploratory",
    rows: cells.map((c) => ({
      key: String(c.group), label: String(c.group), value: c.est,
      ciLo: c.ciLo, ciHi: c.ciHi, naive: c.naive?.est, n: c.n,
    })),
    diff: r.diff ?? null,
  };
}

// ------------------------------------------------------------------- chart

// Horizontal bars, direct labels, one thin zero axis — nothing else. Solid
// accent fill only at Corrected; everything below renders hatched (the
// uncorrected texture), and naive companions are always hatched.
function svgChart({ rows, level, idx }) {
  const mark = LEVEL_MARKS[level] ?? "◌";
  const corrected = level === "corrected";
  const W = 640;
  const gutter = 130;
  const labelW = 120;
  const barH = 16;
  const naiveH = 9;
  const rowGap = 18;
  const top = 8;
  let lo = 0;
  let hi = 0;
  for (const r of rows) {
    for (const v of [r.value, r.ciLo, r.ciHi, r.naive]) {
      if (typeof v === "number" && Number.isFinite(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (hi - lo < 1e-12) hi = lo + 1;
  const plotW = W - gutter - labelW;
  const x = (v) => gutter + ((v - lo) / (hi - lo)) * plotW;
  const rowH = (r) => barH + (typeof r.naive === "number" ? naiveH + 3 : 0) + rowGap;
  const H = top + rows.reduce((a, r) => a + rowH(r), 0) + 6;
  const hatchId = `hatch-${idx}`;
  const p = [];
  p.push(`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="bar chart">`);
  p.push(`<defs><pattern id="${hatchId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="6" height="6" fill="#FAF7F2"></rect>` +
    `<line x1="0" y1="0" x2="0" y2="6" stroke="#2B4C7E" stroke-width="2"></line></pattern></defs>`);
  let y = top;
  for (const r of rows) {
    const yBar = y;
    const v = typeof r.value === "number" ? r.value : 0;
    const x0 = x(Math.min(0, v));
    const x1 = x(Math.max(0, v));
    p.push(`<g data-evidence="${esc(r.key)}">`);
    p.push(`<text x="${gutter - 10}" y="${yBar + barH - 4}" text-anchor="end" class="bar-label">${esc(r.label)}</text>`);
    p.push(`<rect x="${x0}" y="${yBar}" width="${Math.max(1, x1 - x0)}" height="${barH}" fill="${corrected ? "#1F6F6B" : `url(#${hatchId})`}" stroke="#1F6F6B" stroke-width="1"></rect>`);
    if (typeof r.ciLo === "number" && typeof r.ciHi === "number") {
      const cy = yBar + barH / 2;
      p.push(`<line x1="${x(r.ciLo)}" y1="${cy}" x2="${x(r.ciHi)}" y2="${cy}" stroke="#1A1815" stroke-width="1.2"></line>`);
      p.push(`<line x1="${x(r.ciLo)}" y1="${cy - 4}" x2="${x(r.ciLo)}" y2="${cy + 4}" stroke="#1A1815" stroke-width="1.2"></line>`);
      p.push(`<line x1="${x(r.ciHi)}" y1="${cy - 4}" x2="${x(r.ciHi)}" y2="${cy + 4}" stroke="#1A1815" stroke-width="1.2"></line>`);
    }
    p.push(`<text x="${Math.max(x1, typeof r.ciHi === "number" ? x(r.ciHi) : x1) + 8}" y="${yBar + barH - 4}" class="bar-value">${fmt(v, 2)} <tspan class="mark">${mark}</tspan></text>`);
    if (typeof r.naive === "number") {
      const yN = yBar + barH + 3;
      const nx0 = x(Math.min(0, r.naive));
      const nx1 = x(Math.max(0, r.naive));
      p.push(`<rect x="${nx0}" y="${yN}" width="${Math.max(1, nx1 - nx0)}" height="${naiveH}" fill="url(#${hatchId})" stroke="#2B4C7E" stroke-width="1"></rect>`);
      p.push(`<text x="${nx1 + 8}" y="${yN + naiveH}" class="bar-naive">${fmt(r.naive, 2)} uncorrected</text>`);
    }
    p.push("</g>");
    y += rowH(r);
  }
  p.push(`<line x1="${x(0)}" y1="${top - 4}" x2="${x(0)}" y2="${H - 4}" stroke="#1A1815" stroke-width="1"></line>`);
  p.push("</svg>");
  return p.join("");
}

function chartBlock(analysis, content, idx, exploratoryFlag) {
  const { title, level, rows, diff } = rowsFrom(analysis, content);
  if (level === "exploratory") exploratoryFlag.any = true;
  const mark = LEVEL_MARKS[level] ?? "◌";
  const parts = [];
  parts.push(`<section class="block block-chart" data-level="${esc(level)}">`);
  parts.push(`<h3 class="block-title">${esc(title)} <span class="mark" title="${esc(LEVEL_NAMES[level] ?? level)}">${mark}</span></h3>`);
  parts.push(svgChart({ rows, level, idx }));
  if (diff && typeof diff.est === "number") {
    parts.push(`<p class="annot">Δ ${esc(String(diff.a))} − ${esc(String(diff.b))} = ${fmt(diff.est, 3)} <span class="mark">${mark}</span>, 95% CI [${fmt(diff.ciLo, 3)}, ${fmt(diff.ciHi, 3)}]${diff.naive ? `; naive ${fmt(diff.naive.est, 3)}` : ""}</p>`);
  }
  parts.push(`<p class="hint">Click a bar to open its evidence quotes</p>`);
  parts.push("</section>");
  return parts.join("\n");
}

function tableBlock(analysis, content, exploratoryFlag) {
  if (content?.columns && content?.rows) {
    const parts = [`<section class="block block-table">`];
    if (content.title) parts.push(`<h3 class="block-title">${esc(content.title)}</h3>`);
    parts.push(`<table class="data"><thead><tr>${content.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>`);
    for (const row of content.rows) parts.push(`<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`);
    parts.push("</tbody></table></section>");
    return parts.join("\n");
  }
  const { title, level, rows, diff } = rowsFrom(analysis, content);
  if (level === "exploratory") exploratoryFlag.any = true;
  const mark = LEVEL_MARKS[level] ?? "◌";
  const corrected = level === "corrected";
  const hasCi = rows.some((r) => typeof r.ciLo === "number");
  const hasNaive = rows.some((r) => typeof r.naive === "number");
  const hasN = rows.some((r) => typeof r.n === "number");
  const parts = [];
  parts.push(`<section class="block block-table" data-level="${esc(level)}">`);
  parts.push(`<h3 class="block-title">${esc(title)} <span class="mark">${mark}</span></h3>`);
  parts.push(`<table class="data"><thead><tr><th>Group</th>${hasN ? "<th>n</th>" : ""}<th>${corrected ? "Corrected estimate" : "Estimate"}</th>${hasCi ? "<th>95% CI</th>" : ""}${hasNaive ? "<th>Uncorrected</th>" : ""}</tr></thead><tbody>`);
  for (const r of rows) {
    parts.push(`<tr><td data-evidence="${esc(r.key)}" class="evident">${esc(r.label)}</td>` +
      (hasN ? `<td>${r.n ?? ""}</td>` : "") +
      `<td class="${corrected ? "num" : "num uncorrected"}">${fmt(r.value, 3)} <span class="mark">${mark}</span></td>` +
      (hasCi ? `<td class="num">${typeof r.ciLo === "number" ? `[${fmt(r.ciLo, 2)}, ${fmt(r.ciHi, 2)}]` : ""}</td>` : "") +
      (hasNaive ? `<td class="num uncorrected">${typeof r.naive === "number" ? fmt(r.naive, 3) : ""}</td>` : "") +
      "</tr>");
  }
  if (diff && typeof diff.est === "number") {
    parts.push(`<tr class="diff-row"><td>Δ ${esc(String(diff.a))} − ${esc(String(diff.b))}</td>` +
      (hasN ? "<td></td>" : "") +
      `<td class="num">${fmt(diff.est, 3)} <span class="mark">${mark}</span></td>` +
      (hasCi ? `<td class="num">[${fmt(diff.ciLo, 2)}, ${fmt(diff.ciHi, 2)}]</td>` : "") +
      (hasNaive ? `<td class="num uncorrected">${diff.naive ? fmt(diff.naive.est, 3) : ""}</td>` : "") +
      "</tr>");
  }
  parts.push("</tbody></table></section>");
  return parts.join("\n");
}

// ------------------------------------------------------- prose-like blocks

function textBlock(content) {
  const paras = String(content).split(/\n{2,}/).map((t) => `<p>${esc(t.trim())}</p>`).join("\n");
  return `<section class="block block-text">\n${paras}\n</section>`;
}

function quoteBlock(unit) {
  const meta = unit.meta ? Object.entries(unit.meta).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ") : "";
  return `<section class="block block-quote">\n<blockquote class="quote"><p>${esc(unit.text)}</p>` +
    `<footer>${esc(unit.id)}${meta ? ` · ${meta}` : ""}</footer></blockquote>\n</section>`;
}

function inlineMd(text) {
  return esc(text).replace(/\[ledger:([0-9a-f]{8})\]/g, '<cite class="cite">ledger:$1</cite>');
}

// Minimal markdown renderer for the methods excerpt: headings, paragraphs,
// pipe tables, citation tokens → chips. Nothing else is needed (or allowed).
function mdToHtml(md) {
  const out = [];
  let para = [];
  let inTable = false;
  const flush = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(" "))}</p>`);
      para = [];
    }
  };
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (t.startsWith("|")) {
      if (!inTable) {
        flush();
        out.push('<table class="md-table"><tbody>');
        inTable = true;
      }
      if (/^\|[\s\-|:]+\|$/.test(t)) continue;
      const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => inlineMd(c.trim()));
      out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`);
      continue;
    }
    if (inTable) {
      out.push("</tbody></table>");
      inTable = false;
    }
    if (t.startsWith("> ")) {
      flush();
      out.push(`<p class="preview-banner">${inlineMd(t.slice(2))}</p>`);
    } else if (t.startsWith("## ")) {
      flush();
      out.push(`<h4>${inlineMd(t.slice(3))}</h4>`);
    } else if (t.startsWith("# ")) {
      flush();
      out.push(`<h3>${inlineMd(t.slice(2))}</h3>`);
    } else if (t === "") {
      flush();
    } else {
      para.push(t);
    }
  }
  if (inTable) out.push("</tbody></table>");
  flush();
  return out.join("\n");
}

// --------------------------------------------------------------------- css

function css(withWatermark) {
  return `
:root{--paper:#FAF7F2;--ink:#1A1815;--accent:#1F6F6B;--gold:#B8860B;--machine:#2B4C7E;--signal:#C75000;--muted:#6F6759;--rule:#E4DCCB}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#FAF7F2;color:#1A1815;font-family:"IBM Plex Sans","Segoe UI",system-ui,-apple-system,sans-serif;line-height:1.55;font-size:16px}
header.masthead{max-width:780px;margin:0 auto;padding:2.2rem 1.5rem 1rem;border-bottom:2px solid var(--ink)}
.kicker{font-family:"IBM Plex Mono",Consolas,"Courier New",monospace;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
h1{font-family:"Fraunces",Georgia,"Times New Roman",serif;font-weight:900;font-size:2rem;margin:.35rem 0 .4rem}
h2,h3,h4{font-family:"Fraunces",Georgia,"Times New Roman",serif;font-weight:600}
.legend{font-size:.78rem;color:var(--muted)}
main{max-width:780px;margin:0 auto;padding:1rem 1.5rem 6rem}
.block{margin:2.4rem 0}
.block-title{font-size:1.15rem;margin:0 0 .8rem}
.mark{color:var(--accent);font-style:normal}
.bar-label{font-size:13px;fill:#1A1815}
.bar-value{font-size:13px;fill:#1A1815;font-family:"IBM Plex Mono",Consolas,monospace}
.bar-naive{font-size:11px;fill:#2B4C7E;font-family:"IBM Plex Mono",Consolas,monospace}
.annot{font-size:.85rem;color:var(--ink)}
.hint{font-size:.72rem;color:var(--muted);font-family:"IBM Plex Mono",Consolas,monospace}
[data-evidence]{cursor:pointer}
td.evident{text-decoration:underline dotted var(--accent);text-underline-offset:3px}
table.data{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
table.data th{text-align:left;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1.5px solid var(--ink);padding:.35rem .6rem}
table.data td{border-bottom:1px solid var(--rule);padding:.4rem .6rem}
td.num{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.9rem}
td.uncorrected,.uncorrected{color:var(--machine)}
tr.diff-row td{border-top:1.5px solid var(--ink);font-weight:600}
.block-quote .quote{font-family:"Fraunces",Georgia,"Times New Roman",serif;font-size:1.12rem;margin:1.2rem 0 1.2rem 1.6rem;position:relative;white-space:pre-line}
.quote::before{content:"\\201C";position:absolute;left:-1.5rem;top:-.45rem;font-size:2.6rem;line-height:1;color:var(--accent)}
.quote footer{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.7rem;color:var(--muted);margin-top:.5rem}
.block-methods{background:#FFFDF8;border:1px solid var(--rule);padding:1rem 1.4rem;border-radius:4px}
.block-methods h3{margin-top:.2rem}
.preview-banner{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--signal);border:1px dashed var(--signal);border-radius:3px;padding:.3rem .6rem;display:inline-block}
.cite{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.66rem;font-style:normal;background:#EFE8D8;color:var(--muted);border-radius:3px;padding:0 .32em;white-space:nowrap}
table.md-table{border-collapse:collapse;margin:.6rem 0}
table.md-table td{border-bottom:1px solid var(--rule);padding:.25rem .6rem;font-size:.88rem}
#evidence-panel{position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);background:#FFFDF8;border-left:2px solid var(--ink);box-shadow:-10px 0 28px rgba(26,24,21,.14);padding:1.2rem;overflow:auto;z-index:40}
.evidence-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--rule);padding-bottom:.5rem;margin-bottom:.8rem}
#evidence-close{background:none;border:1px solid var(--ink);border-radius:3px;font:inherit;font-size:.75rem;padding:.15rem .6rem;cursor:pointer}
#evidence-body blockquote{font-family:"Fraunces",Georgia,serif;margin:0 0 1.1rem;padding-left:.9rem;border-left:3px solid var(--accent);white-space:pre-line}
#evidence-body footer{font-family:"IBM Plex Mono",Consolas,monospace;font-size:.68rem;color:var(--muted);margin-top:.3rem}
${withWatermark ? `
.watermark-band{position:sticky;top:0;z-index:50;background:repeating-linear-gradient(-45deg,#C75000 0 14px,#A84500 14px 28px);color:#FFF6EC;font-family:"IBM Plex Mono",Consolas,monospace;font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;text-align:center;padding:.45rem .8rem}
` : ""}
@media print{
body{background:#fff;font-size:11pt}
#evidence-panel{display:none !important}
.hint{display:none}
[data-evidence]{cursor:auto}
td.evident{text-decoration:none}
.block{break-inside:avoid;page-break-inside:avoid}
header.masthead{padding-top:0}
${withWatermark ? ".watermark-band{position:static;-webkit-print-color-adjust:exact;print-color-adjust:exact}" : ""}
}
`;
}

// ------------------------------------------------------------------ script

const DRILLDOWN_JS = `
(function () {
  var blob = document.getElementById("concord-evidence");
  var data = JSON.parse(blob.textContent);
  var panel = document.getElementById("evidence-panel");
  var body = document.getElementById("evidence-body");
  var title = document.getElementById("evidence-title");
  document.addEventListener("click", function (ev) {
    var el = ev.target.closest ? ev.target.closest("[data-evidence]") : null;
    if (!el) { return; }
    var key = el.getAttribute("data-evidence");
    var items = data.evidence[key] || [];
    title.textContent = "Evidence — " + key;
    body.textContent = "";
    items.forEach(function (it) {
      var q = document.createElement("blockquote");
      var p = document.createElement("p");
      p.textContent = it.text;
      q.appendChild(p);
      var f = document.createElement("footer");
      var bits = [it.unitId];
      if (it.label !== null) { bits.push("label " + it.label); }
      if (it.confidence !== null) { bits.push("conf " + Number(it.confidence).toFixed(2)); }
      f.textContent = bits.join(" · ");
      if (it.rationale) {
        var r = document.createElement("div");
        r.textContent = it.rationale;
        f.appendChild(r);
      }
      q.appendChild(f);
      body.appendChild(q);
    });
    if (items.length === 0) { body.textContent = "No linked evidence for this cell."; }
    panel.hidden = false;
  });
  document.getElementById("evidence-close").addEventListener("click", function () {
    panel.hidden = true;
  });
})();
`;

// ------------------------------------------------------------------ render

export async function render(project, layout, { projectDir } = {}) {
  if (!project || typeof project !== "object" || !project.id) fail("render requires a project object");
  if (!Array.isArray(layout)) fail("render requires layout to be an array of blocks");
  if (typeof projectDir !== "string" || !projectDir) fail("render requires options.projectDir");

  for (let i = 0; i < layout.length; i++) {
    const b = layout[i];
    if (!b || typeof b !== "object" || !KINDS.has(b.kind)) {
      fail(`layout[${i}] has unknown kind`, { block: i, kind: b?.kind });
    }
    if (b.kind === "text" && typeof b.content !== "string") fail(`layout[${i}] text block needs string content`, { block: i });
    if (b.kind !== "text" && b.ref === undefined && b.content === undefined) {
      fail(`layout[${i}] ${b.kind} block needs a ref or inline content`, { block: i });
    }
  }

  const unitsMap = await loadAllUnits(project, projectDir);
  const outputsCache = new Map();
  const evidence = {};
  const exploratoryFlag = { any: false };
  const blocksHtml = [];

  for (let i = 0; i < layout.length; i++) {
    const b = layout[i];
    if (b.kind === "text") {
      blocksHtml.push(textBlock(b.content));
      continue;
    }
    if (b.kind === "quote") {
      if (b.content !== undefined) {
        blocksHtml.push(quoteBlock({ id: b.content.attribution ?? "quote", text: b.content.text ?? String(b.content), meta: null }));
        continue;
      }
      const unit = unitsMap.get(b.ref);
      if (!unit) throw new ConcordError("NOT_FOUND", `Unit '${b.ref}' not found in any corpus`, { unitId: b.ref }, { status: 404 });
      blocksHtml.push(quoteBlock(unit));
      continue;
    }
    if (b.kind === "methods-excerpt") {
      // Side-effect-free by default: rendering a report canvas must not mint
      // export.methods events of record (canvas redraws would inflate the
      // ledger and stamp previews as exports). A block opts into a real
      // export with {sideEffectFree: false}; the exports route uses
      // methods.generate directly.
      const sideEffectFree = b.sideEffectFree !== false;
      const md = typeof b.content === "string"
        ? b.content
        : (await (sideEffectFree ? previewMethods : generateMethods)(project, b.ref, { projectDir })).markdown;
      blocksHtml.push(`<section class="block block-methods">\n${mdToHtml(md)}\n</section>`);
      continue;
    }
    // chart | table
    const analysis = b.ref !== undefined ? await loadAnalysis(project, projectDir, b.ref) : null;
    if (analysis) await evidenceFor(analysis, projectDir, unitsMap, outputsCache, evidence);
    blocksHtml.push(b.kind === "chart"
      ? chartBlock(analysis, b.content, i, exploratoryFlag)
      : tableBlock(analysis, b.content, exploratoryFlag));
  }

  const watermark = exploratoryFlag.any;
  const evidenceJson = JSON.stringify({ evidence }).replace(/</g, "\\u003c");
  const legend = Object.keys(LEVEL_MARKS)
    .map((l) => `${LEVEL_MARKS[l]} ${LEVEL_NAMES[l].toLowerCase()}`)
    .join(" · ");

  const html = [];
  html.push("<!DOCTYPE html>");
  html.push('<html lang="en">');
  html.push("<head>");
  html.push('<meta charset="utf-8">');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  html.push(`<title>${esc(project.name)} — Concord report</title>`);
  html.push(`<style>${css(watermark)}</style>`);
  html.push("</head>");
  html.push("<body>");
  if (watermark) {
    html.push(`<div class="watermark-band">${LEVEL_MARKS.exploratory} EXPLORATORY — contains estimates with no human validation</div>`);
  }
  html.push('<header class="masthead">');
  html.push('<div class="kicker">Concord evidence report</div>');
  html.push(`<h1>${esc(project.name)}</h1>`);
  html.push(`<div class="legend">Evidence ladder: ${legend}. Every number is a door: click bars and group cells for verbatim evidence.</div>`);
  html.push("</header>");
  html.push("<main>");
  html.push(blocksHtml.join("\n"));
  html.push("</main>");
  html.push('<aside id="evidence-panel" hidden>');
  html.push('<div class="evidence-head"><strong id="evidence-title">Evidence</strong><button id="evidence-close" type="button">Close</button></div>');
  html.push('<div id="evidence-body"></div>');
  html.push("</aside>");
  html.push(`<script type="application/json" id="concord-evidence">${evidenceJson}</script>`);
  html.push(`<script>${DRILLDOWN_JS}</script>`);
  html.push("</body>");
  html.push("</html>");
  return html.join("\n");
}
