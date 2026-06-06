// Reports — #/p/:slug/reports — what leaves the room. Three surfaces:
//   Methods preview — the generated methods section, every sentence wearing a
//     [ledger:…] citation chip whose hover shows the event it cites; one
//     "Export of record" button downloads the .md.
//   Replication archive — contents list, the includeGoldText decision stated
//     honestly, download.
//   Report canvas — blocks (chart / table / quote / text / methods excerpt)
//     assembled from project artifacts, reorderable, rendered to a standalone
//     HTML file.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as toast from "../components/toast.js";
import * as ladderC from "../components/ladder.js";
import { store } from "../state.js";
import { screenHead, section, asyncMount, ensureProject, emptyState, mdBlock, downloadText, openSheet } from "./_shared.js";

export const route = "p/:slug/reports";
export const title = "Reports";

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const methods = await api.exports.methods(params.slug).catch((err) => ({ error: err }));
    let replication = null;
    if (typeof api.exports.replicationContents === "function") {
      replication = await api.exports.replicationContents(params.slug).catch(() => null);
    }
    return { project, methods, replication };
  }, ({ project, methods, replication }) => {
    mount.append(screenHead({
      overline: "Reports",
      title: "Export the study.",
      lede: "Three exports: a methods section generated from the ledger, a replication archive that recomputes every number outside Concord, and a standalone HTML report you assemble from blocks.",
    }));

    /* ================= methods preview ================= */
    const methodsHost = el("div", { class: "methods" });
    if (methods?.error) {
      methodsHost.append(emptyState({
        title: "No methods to preview.",
        body: String(methods.error.message ?? methods.error),
        hint: "Methods generate from the ledger — import, calibrate, and analyze first.",
      }));
    } else {
      // live citations: [{token: "ledger:<hash8>", hash: <full sha>, type}] —
      // inline tokens carry the 8-char prefix, so key the lookup by it
      const citations = new Map((methods.citations ?? []).map((c) => [String(c.hash).slice(0, 8), c]));
      methodsHost.append(
        el("div", { class: "methods__page" },
          mdBlock(methods.markdown ?? "", {
            chipFn: (token) => {
              const m = token.match(/^ledger:(.+)$/);
              if (!m) return null;
              return citationChip(m[1], citations.get(m[1]));
            },
          })),
        el("div", { class: "methods__actions" },
          el("button", {
            class: "btn btn--primary", type: "button",
            onclick: () => {
              downloadText(`${params.slug}-methods.md`, methods.markdown ?? "", "text/markdown");
              toast.success("Methods exported.", { detail: `${params.slug}-methods.md — every sentence keeps its ledger citation`, data: true });
            },
          }, "Export of record (.md)"),
          el("span", { class: "faint data" }, `${(methods.citations ?? []).length} ledger citations`)),
      );
    }
    mount.append(section("Methods — generated from the ledger", methodsHost));

    /* ================= replication archive ================= */
    const repHost = el("div", { class: "repcard" });
    if (!replication) {
      repHost.append(el("p", { class: "faint" },
        "The replication archive builds server-side (zip stream). Contents: codebook, frozen instrument payloads incl. prompts, dictionaries, gold with π, outputs, agreement reports, analysis specs, and reproduce.R / reproduce.py that recompute every corrected estimate."));
      repHost.append(downloadRow());
    } else {
      let includeGoldText = false;
      repHost.append(
        el("ul", { class: "repfiles", role: "list" },
          ...(replication.files ?? []).map((f) =>
            el("li", { class: "repfile" },
              el("code", { class: "data repfile__path" }, f.path),
              el("span", { class: "repfile__note faint" }, f.note)))),
        el("label", { class: "switch repcard__toggle" },
          el("input", { type: "checkbox", onchange: (e) => { includeGoldText = e.target.checked; } }),
          el("span", {}, "Include gold-set verbatims"),
          el("span", { class: "faint" }, ` — ${replication.goldTextNote ?? "license and PII review is yours."}`)),
        downloadRow(replication.sizeApprox),
      );
    }
    mount.append(section("Replication archive", repHost));

    function downloadRow(sizeApprox) {
      return el("p", { class: "repcard__dl" },
        el("button", {
          class: "btn", type: "button",
          onclick: () => api.exports.download(params.slug, "replication"),
        }, "Download zip"),
        sizeApprox ? el("span", { class: "faint data" }, ` ~${sizeApprox}`) : null);
    }

    /* ================= report canvas ================= */
    const canvasHost = el("div", { class: "repcanvas" });
    mount.append(section("Report canvas", canvasHost));
    reportCanvas(canvasHost, params, project);
  }, "Assembling exports…");
}

// cite: {token, hash (full chain hash), type} from the live methods route
function citationChip(hash8, cite) {
  const chip = el("button", {
    class: "citechip data", type: "button",
    aria: { label: cite ? `Ledger ${hash8}: ${cite.type}` : `Ledger citation ${hash8}` },
  },
    el("span", { class: "citechip__mark", aria: { hidden: "true" } }, "⎆"),
    hash8,
    cite
      ? el("span", { class: "citechip__pop", role: "tooltip", aria: { hidden: "true" } },
          el("span", { class: "citechip__type" }, cite.type),
          el("span", { class: "citechip__meta" }, String(cite.hash)))
      : null,
  );
  return chip;
}

/* ================= the canvas ============================================================= */

const BLOCK_TYPES = [
  { type: "chart", label: "Chart", hint: "a computed analysis, drawn" },
  { type: "table", label: "Table", hint: "a computed analysis, tabulated" },
  { type: "quote", label: "Quote", hint: "a verbatim, with its source line" },
  { type: "text", label: "Text", hint: "your prose" },
  { type: "methods", label: "Methods excerpt", hint: "a section of the generated methods" },
];

function reportCanvas(host, params, project) {
  const blocks = store.get("report.blocks") ?? [];

  const listEl = el("ol", { class: "blocklist", role: "list" });
  const redraw = () => {
    clear(listEl);
    const current = store.get("report.blocks") ?? [];
    if (!current.length) {
      listEl.append(el("li", { class: "blocklist__empty" },
        emptyState({
          title: "No blocks yet.",
          body: "Use “+ Add block” below to pull in charts, tables, quotes, and methods excerpts — Workbench results carry an “Add to report” button too.",
        })));
    }
    current.forEach((b, i) => {
      listEl.append(el("li", { class: "block" },
        el("span", { class: "block__type chip" }, b.type),
        el("span", { class: "block__title" },
          b.title ?? "(untitled)",
          b.level ? ladderC.render({ level: b.level, size: "sm" }) : null),
        el("span", { class: "block__tools" },
          el("button", { class: "btn btn--quiet", type: "button", disabled: i === 0, aria: { label: "Move up" }, onclick: () => move(i, -1) }, "↑"),
          el("button", { class: "btn btn--quiet", type: "button", disabled: i === current.length - 1, aria: { label: "Move down" }, onclick: () => move(i, 1) }, "↓"),
          el("button", { class: "btn btn--quiet", type: "button", aria: { label: "Remove block" }, onclick: () => { current.splice(i, 1); store.set("report.blocks", current); redraw(); } }, "×")),
      ));
    });
  };

  function move(i, delta) {
    const current = store.get("report.blocks") ?? [];
    const j = i + delta;
    if (j < 0 || j >= current.length) return;
    [current[i], current[j]] = [current[j], current[i]];
    store.set("report.blocks", current);
    redraw();
  }

  redraw();

  host.append(
    listEl,
    el("div", { class: "repcanvas__actions" },
      el("button", { class: "btn", type: "button", onclick: () => addBlockSheet(params, project, redraw) }, "+ Add block"),
      el("button", {
        class: "btn btn--primary", type: "button",
        onclick: () => renderReport(params, project),
      }, "Render → standalone HTML")),
  );
}

function addBlockSheet(params, project, redraw) {
  const s = openSheet({ title: "Add a block", overline: "From this project's artifacts" });
  const analyses = project.analyses ?? [];

  for (const bt of BLOCK_TYPES) {
    const row = el("div", { class: "addblock" },
      el("div", { class: "addblock__text" },
        el("h3", { class: "addblock__label" }, bt.label),
        el("p", { class: "faint" }, bt.hint)),
    );
    if (bt.type === "chart" || bt.type === "table") {
      const sel = el("select", { class: "input input--inline", "aria-label": `${bt.label} source` },
        ...analyses.map((a) => el("option", { value: a.id }, a.name ?? a.id)));
      row.append(sel,
        el("button", {
          class: "btn", type: "button",
          onclick: () => {
            const a = analyses.find((x) => x.id === sel.value) ?? analyses[0];
            if (!a) { toast.warn("No analyses yet."); return; }
            push({ type: bt.type, source: "analysis", analysisId: a.id, title: a.name ?? a.id, level: a.level });
          },
        }, "Add"));
    } else if (bt.type === "quote") {
      const input = el("input", { class: "input input--inline", placeholder: "unit id (u_…)", "aria-label": "Unit id" });
      row.append(input,
        el("button", {
          class: "btn", type: "button",
          onclick: () => {
            if (!input.value.trim()) { input.focus(); return; }
            push({ type: "quote", unitId: input.value.trim(), title: `quote · ${input.value.trim().slice(0, 12)}` });
          },
        }, "Add"));
    } else if (bt.type === "text") {
      row.append(el("button", {
        class: "btn", type: "button",
        onclick: () => push({ type: "text", text: "", title: "text block" }),
      }, "Add"));
    } else {
      row.append(el("button", {
        class: "btn", type: "button",
        onclick: () => push({ type: "methods", title: "methods excerpt" }),
      }, "Add"));
    }
    s.body.append(row);
  }
  s.foot.append(el("button", { class: "btn", type: "button", onclick: () => s.close() }, "Done"));

  function push(block) {
    const blocks = store.get("report.blocks") ?? [];
    blocks.push({ id: `blk_${Date.now().toString(36)}${blocks.length}`, ...block });
    store.set("report.blocks", blocks);
    redraw();
    toast.success("Block added.", { detail: block.title, duration: 1800 });
  }
}

/* Render the canvas to a single-file HTML download. The live server route
   (GET exports/report) does this with full chart SVG; this client-side render
   keeps the affordance honest in fixtures mode and offline. */
async function renderReport(params, project) {
  const blocks = store.get("report.blocks") ?? [];
  if (!blocks.length) {
    toast.warn("The canvas is empty.", { detail: "add at least one block first" });
    return;
  }
  let methodsMd = "";
  try {
    const m = await api.exports.methods(params.slug);
    methodsMd = m.markdown ?? "";
  } catch { /* methods optional */ }

  const parts = [];
  for (const b of blocks) {
    if (b.type === "methods") {
      parts.push(`<section class="block"><h2>Methods</h2><pre class="md">${escapeHtml(methodsMd)}</pre></section>`);
    } else if (b.type === "quote" && b.unitId) {
      let text = b.unitId;
      try {
        const dossier = await api.evidence.get(params.slug, b.unitId);
        text = dossier?.unit?.text ?? b.unitId;
      } catch { /* keep the id */ }
      parts.push(`<section class="block"><blockquote class="quote">${escapeHtml(text)}</blockquote><p class="source">${escapeHtml(b.unitId)}</p></section>`);
    } else if (b.type === "text") {
      parts.push(`<section class="block"><p>${escapeHtml(b.text ?? "")}</p></section>`);
    } else {
      parts.push(`<section class="block"><h2>${escapeHtml(b.title ?? b.type)}${b.level ? ` <span class="mark">${markFor(b.level)}</span>` : ""}</h2><p class="note">Analysis ${escapeHtml(b.analysisId ?? "")} — full chart renders in the server export; this standalone draft records the reference and its evidence level.</p></section>`);
    }
  }

  const exploratory = blocks.some((b) => b.level === "exploratory");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(project.name)} — report</title>
<style>
  body{font-family:Georgia,serif;max-width:42rem;margin:3rem auto;padding:0 1.5rem;color:#1A1815;background:#FAF7F2;line-height:1.6}
  h1{font-size:1.9rem} h2{font-size:1.2rem;margin-top:2.2rem}
  .quote{font-style:normal;border-left:2px solid #B8860B;padding-left:1rem;margin:1rem 0}
  .source,.note{font-family:Consolas,monospace;font-size:.75rem;color:#736B61}
  .mark{font-family:Consolas,monospace;font-size:.8em;color:#5B544B}
  pre.md{white-space:pre-wrap;font-family:Consolas,monospace;font-size:.8rem;background:#F2EDE4;padding:1rem;border-radius:4px}
  .watermark{margin-top:3rem;border-top:1px solid #ccc;padding-top:.6rem;font-family:Consolas,monospace;font-size:.72rem;color:#A84300;letter-spacing:.08em}
</style></head><body>
<h1>${escapeHtml(project.name)}</h1>
<p class="note">rendered ${new Date().toISOString()} · Concord</p>
${parts.join("\n")}
${exploratory ? `<p class="watermark">EXPLORATORY ◌ — contains uncalibrated numbers; the watermark travels with them.</p>` : ""}
</body></html>`;

  downloadText(`${params.slug}-report.html`, html, "text/html");
  toast.success("Report rendered.", { detail: `${params.slug}-report.html${exploratory ? " — carries its ◌ watermark" : ""}`, data: true });
}

function markFor(level) {
  return { exploratory: "◌", stabilized: "◑", calibrated: "●", corrected: "◉" }[level] ?? "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
