// Reports — #/p/:slug/reports — what leaves the room. Three surfaces:
//   Methods preview — the generated methods section (side-effect-free preview
//     route: a screen visit never mints an export.methods ledger event),
//     every sentence wearing a [ledger:…] citation chip whose hover shows the
//     event it cites; one "Export of record" button performs the LEDGERED
//     export and downloads the .md.
//   Replication archive — contents list, the gold-verbatim decision a real
//     checkbox whose state rides the download URL (?goldText=0), download.
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

// Side-effect-free methods for screen rendering. Live mode hits the preview
// route (NO export.methods ledger event); fixtures mode (detected the same
// way the rest of this screen does) uses the patched api.exports.methods,
// which is canned data with no ledger behind it.
async function loadMethodsPreview(slug) {
  if (typeof api.exports.replicationContents === "function") {
    return api.exports.methods(slug);
  }
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/exports/methods/preview`);
  let envelope = null;
  try { envelope = await res.json(); } catch { /* non-JSON body falls through */ }
  if (envelope?.ok === true) return envelope.data;
  throw new Error(envelope?.error?.message ?? `methods preview failed (HTTP ${res.status})`);
}

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const methods = await loadMethodsPreview(params.slug).catch((err) => ({ error: err }));
    let replication = null;
    if (typeof api.exports.replicationContents === "function") {
      replication = await api.exports.replicationContents(params.slug).catch(() => null);
    }
    return { project, methods, replication };
  }, ({ project, methods, replication }) => {
    mount.append(screenHead({
      overline: "Reports",
      title: "Export the study.",
      lede: "Three exports: a methods section generated from the ledger, a replication archive that recomputes every corrected proportion outside Concord (corrected regression estimates ship as stored values), and a standalone HTML report you assemble from blocks.",
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
            // the screen renders the side-effect-free preview; the export of
            // record is minted HERE, at the click — it appends export.methods
            // to the ledger and downloads that ledgered text
            onclick: async (e) => {
              e.target.disabled = true;
              try {
                const record = await api.exports.methods(params.slug);
                downloadText(`${params.slug}-methods.md`, record.markdown ?? "", "text/markdown");
                toast.success("Methods exported.", { detail: `${params.slug}-methods.md — export.methods ledgered; every sentence keeps its citation`, data: true });
              } catch (err) {
                toast.error("Export of record failed.", { detail: String(err.message ?? err) });
              }
              e.target.disabled = false;
            },
          }, "Export of record (.md)"),
          el("span", { class: "faint data" }, `${(methods.citations ?? []).length} ledger citations`)),
      );
    }
    mount.append(section("Methods — generated from the ledger", methodsHost));

    /* ================= replication archive ================= */
    // the gold-verbatim decision is a REAL control: default checked (text
    // ships), and the checkbox state rides the download URL as ?goldText=0
    const goldState = { includeGoldText: true };
    const goldToggle = () => el("label", { class: "switch repcard__toggle" },
      el("input", {
        type: "checkbox", checked: true,
        onchange: (e) => { goldState.includeGoldText = e.target.checked; },
      }),
      el("span", {}, "Include gold-set verbatims"),
      el("span", { class: "faint" }, " — gold rows include unit text by default; uncheck to ship labels/π only. License and PII review is yours."));

    const repHost = el("div", { class: "repcard" });
    if (!replication) {
      repHost.append(el("p", { class: "faint" },
        "The replication archive builds server-side (zip stream). Contents: codebook, frozen instrument payloads incl. prompts, dictionaries, gold with π, outputs, agreement reports, analysis specs, and reproduce.R / reproduce.py that recompute every corrected proportion outside Concord; corrected regression estimates ship as stored values in analyses/<id>.json."));
      repHost.append(goldToggle(), downloadRow());
    } else {
      repHost.append(
        el("ul", { class: "repfiles", role: "list" },
          ...(replication.files ?? []).map((f) =>
            el("li", { class: "repfile" },
              el("code", { class: "data repfile__path" }, f.path),
              el("span", { class: "repfile__note faint" }, f.note)))),
        goldToggle(),
        downloadRow(replication.sizeApprox),
      );
    }
    mount.append(section("Replication archive", repHost));

    function downloadReplication() {
      // fixtures mode has no zip stream behind the button — keep its notice
      if (typeof api.exports.replicationContents === "function") {
        api.exports.download(params.slug, "replication");
        return;
      }
      const url = api.exports.replicationUrl(params.slug) + (goldState.includeGoldText ? "" : "?goldText=0");
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.append(a);
      a.click();
      a.remove();
      toast.success("Replication archive downloading.", {
        detail: goldState.includeGoldText ? "gold rows include unit text" : "goldText=0 — labels/π only, no unit text", data: true,
      });
    }

    function downloadRow(sizeApprox) {
      return el("p", { class: "repcard__dl" },
        el("button", {
          class: "btn", type: "button",
          onclick: () => downloadReplication(),
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

// The block vocabulary is the server's: kind ∈ chart|table|quote|text|
// methods-excerpt (validateReportBlock / reporting/report.js). The canvas
// persists exactly what the exporter draws.
const BLOCK_TYPES = [
  { kind: "chart", label: "Chart", hint: "a computed analysis, drawn" },
  { kind: "table", label: "Table", hint: "a computed analysis, tabulated" },
  { kind: "quote", label: "Quote", hint: "a verbatim, with its source line" },
  { kind: "text", label: "Text", hint: "your prose" },
  { kind: "methods-excerpt", label: "Methods excerpt", hint: "the full generated methods document" },
];

// A human label for a persisted block. chart/table/methods carry a title;
// quote and text describe themselves from their ref/content.
function blockTitle(b) {
  if (b.title) return b.title;
  if (b.kind === "quote") return `quote · ${String(b.ref ?? b.content?.attribution ?? "").slice(0, 16) || "verbatim"}`;
  if (b.kind === "text") return "text block";
  if (b.kind === "methods-excerpt") return "methods excerpt";
  return b.ref ?? b.kind;
}

function reportCanvas(host, params, project) {
  // The report is a persisted project artifact: load the saved layout into the
  // session store so the canvas opens with what the server holds (a reload no
  // longer empties it), then persist every edit back through the report routes.
  store.set("report.blocks", (project.report?.blocks ?? []).map((b) => ({ ...b })));

  // PUT replaces the whole layout — the right semantics for reorder/remove and
  // for an add that must land in order. Failures roll the canvas back to the
  // server's last-known layout so the screen never lies about what was saved.
  const persist = async () => {
    const blocks = store.get("report.blocks") ?? [];
    try {
      const saved = await api.report.save(params.slug, blocks);
      // keep the cached project graph honest so re-entering the screen (no hard
      // reload) reflects the saved layout, not the layout this mount opened with
      const cached = store.get("project");
      if (cached?.slug === params.slug) cached.report = saved ?? { blocks, updatedAt: new Date().toISOString() };
    } catch (err) {
      toast.error("Could not save the report layout.", { detail: String(err.message ?? err) });
      try {
        const fresh = await api.projects.get(params.slug);
        store.set("report.blocks", (fresh.report?.blocks ?? []).map((b) => ({ ...b })));
      } catch { /* offline — keep the optimistic copy on screen */ }
      redraw();
    }
  };

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
        el("span", { class: "block__type chip" }, b.kind),
        el("span", { class: "block__title" },
          blockTitle(b),
          b.level ? ladderC.render({ level: b.level, size: "sm" }) : null),
        el("span", { class: "block__tools" },
          el("button", { class: "btn btn--quiet", type: "button", disabled: i === 0, aria: { label: "Move up" }, onclick: () => move(i, -1) }, "↑"),
          el("button", { class: "btn btn--quiet", type: "button", disabled: i === current.length - 1, aria: { label: "Move down" }, onclick: () => move(i, 1) }, "↓"),
          el("button", { class: "btn btn--quiet", type: "button", aria: { label: "Remove block" }, onclick: () => { current.splice(i, 1); store.set("report.blocks", current); redraw(); persist(); } }, "×")),
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
    persist();
  }

  redraw();

  host.append(
    listEl,
    el("div", { class: "repcanvas__actions" },
      el("button", { class: "btn", type: "button", onclick: () => addBlockSheet(params, project, redraw, persist) }, "+ Add block"),
      el("button", {
        class: "btn btn--primary", type: "button",
        onclick: () => renderReport(params, project),
      }, "Render → standalone HTML")),
  );
}

function addBlockSheet(params, project, redraw, persist) {
  const s = openSheet({ title: "Add a block", overline: "From this project's artifacts" });
  const analyses = project.analyses ?? [];

  for (const bt of BLOCK_TYPES) {
    const row = el("div", { class: "addblock" },
      el("div", { class: "addblock__text" },
        el("h3", { class: "addblock__label" }, bt.label),
        el("p", { class: "faint" }, bt.hint)),
    );
    if (bt.kind === "chart" || bt.kind === "table") {
      const sel = el("select", { class: "input input--inline", "aria-label": `${bt.label} source` },
        ...analyses.map((a) => el("option", { value: a.id }, a.name ?? a.id)));
      row.append(sel,
        el("button", {
          class: "btn", type: "button",
          onclick: () => {
            const a = analyses.find((x) => x.id === sel.value) ?? analyses[0];
            if (!a) { toast.warn("No analyses yet."); return; }
            push({ kind: bt.kind, ref: a.id, title: a.name ?? a.id, level: a.level });
          },
        }, "Add"));
    } else if (bt.kind === "quote") {
      const input = el("input", { class: "input input--inline", placeholder: "unit id (u_…)", "aria-label": "Unit id" });
      row.append(input,
        el("button", {
          class: "btn", type: "button",
          onclick: () => {
            if (!input.value.trim()) { input.focus(); return; }
            push({ kind: "quote", ref: input.value.trim(), title: `quote · ${input.value.trim().slice(0, 12)}` });
          },
        }, "Add"));
    } else if (bt.kind === "text") {
      row.append(el("button", {
        class: "btn", type: "button",
        onclick: () => push({ kind: "text", content: "" }),
      }, "Add"));
    } else {
      // methods-excerpt: a side-effect-free preview of the generated methods
      // (the server renders the full section; ref omitted = whole methods)
      row.append(el("button", {
        class: "btn", type: "button",
        onclick: () => push({ kind: "methods-excerpt", title: "methods excerpt" }),
      }, "Add"));
    }
    s.body.append(row);
  }
  s.foot.append(el("button", { class: "btn", type: "button", onclick: () => s.close() }, "Done"));

  function push(block) {
    const blocks = store.get("report.blocks") ?? [];
    blocks.push(block);
    store.set("report.blocks", blocks);
    redraw();
    persist?.();
    toast.success("Block added.", { detail: blockTitle(block), duration: 1800 });
  }
}

/* Render the canvas to a single-file HTML download. The persisted blocks are
   the server's source of truth, so the live path streams the full report
   (real chart SVG + evidence drill-down) straight from GET exports/report.
   The client-side render below stays as the honest fixtures/offline fallback,
   reading the SAME canonical block schema {kind, ref?, content?}. */
async function renderReport(params, project) {
  const blocks = store.get("report.blocks") ?? [];
  if (!blocks.length) {
    toast.warn("The canvas is empty.", { detail: "add at least one block first" });
    return;
  }
  // Live: the server renders the persisted layout with full fidelity. Fixtures
  // mode patches exports.download to a notice, so fall through to the local
  // draft when there is no streaming server behind the button.
  if (typeof api.exports.replicationContents !== "function") {
    api.exports.download(params.slug, "report");
    toast.success("Report streaming from the server.", {
      detail: `${params.slug}-report.html — full charts and evidence drill-down`, data: true,
    });
    return;
  }

  let methodsMd = "";
  try {
    // the local draft is a preview surface — render through the
    // side-effect-free path, never minting an export-of-record event
    const m = await loadMethodsPreview(params.slug);
    methodsMd = m.markdown ?? "";
  } catch { /* methods optional */ }

  const parts = [];
  for (const b of blocks) {
    if (b.kind === "methods-excerpt") {
      const md = typeof b.content === "string" ? b.content : methodsMd;
      parts.push(`<section class="block"><h2>Methods</h2><pre class="md">${escapeHtml(md)}</pre></section>`);
    } else if (b.kind === "quote") {
      const ref = b.ref ?? "";
      let text = b.content?.text ?? ref;
      if (b.content?.text === undefined && ref) {
        try {
          const dossier = await api.evidence.get(params.slug, ref);
          text = dossier?.unit?.text ?? ref;
        } catch { /* keep the id */ }
      }
      const source = b.content?.attribution ?? ref;
      parts.push(`<section class="block"><blockquote class="quote">${escapeHtml(text)}</blockquote><p class="source">${escapeHtml(source)}</p></section>`);
    } else if (b.kind === "text") {
      parts.push(`<section class="block"><p>${escapeHtml(b.content ?? "")}</p></section>`);
    } else {
      parts.push(`<section class="block"><h2>${escapeHtml(blockTitle(b))}${b.level ? ` <span class="mark">${markFor(b.level)}</span>` : ""}</h2><p class="note">Analysis ${escapeHtml(b.ref ?? "")} — full chart renders in the server export; this standalone draft records the reference and its evidence level.</p></section>`);
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
