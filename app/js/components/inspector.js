// The evidence inspector — the soul of the product. Any element anywhere
// that carries data-evidence="<unitId>" (or a comma list) is a door; the
// delegated handler below opens this panel with the unit's full dossier:
// the verbatim (serif), dictionary hits, every juror's label + confidence +
// rationale (machine blue), the gold label when one exists (gold), and the
// unit's position in its source. Every number wears its ladder mark.
//
//   init({ host, appRoot })          mount the panel skeleton
//   initEvidenceDelegation(fetcher)  fetcher(unitId) → Promise<dossier>
//   open(dossier | promise)          show; openUnit(unitId) fetches first
//   close()                          slide away (Escape works too)
//
// Dossier shape (GET /api/projects/:p/evidence/:unitId):
//   { unit, dictionaryHits, outputs, goldLabels, sourcePos }

import { el, clear } from "../dom.js";
import { bus } from "../bus.js";
import * as quotecard from "./quotecard.js";
import * as ladder from "./ladder.js";
import { fmtStat } from "../format.js";

let host = null;
let appRoot = null;
let body = null;
let titleEl = null;
let lastTrigger = null;
let fetcherFn = null;

/** Build the panel chrome inside the inspector zone. Idempotent. */
export function init({ host: hostEl, appRoot: rootEl } = {}) {
  host = hostEl ?? document.getElementById("inspector");
  appRoot = rootEl ?? host?.closest(".app") ?? document.querySelector(".app");
  if (!host) return;
  clear(host);
  host.setAttribute("role", "complementary");
  host.setAttribute("aria-label", "Evidence");

  titleEl = el("h2", { class: "inspector__title" }, "Evidence");
  body = el("div", { class: "inspector__body" });

  host.append(
    el("div", { class: "inspector__panel" },
      el("header", { class: "inspector__head" },
        el("span", { class: "overline" }, "Inspector"),
        titleEl,
        el("button", {
          class: "inspector__close",
          type: "button",
          aria: { label: "Close inspector" },
          onclick: close,
        }, "×"),
      ),
      body,
    ),
  );

  host.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  });
}

export function isOpen() {
  return appRoot?.dataset.inspector === "open";
}

/** Open with a dossier object or a promise of one. */
export function open(dossier, { title } = {}) {
  if (!host) init({});
  if (!host) return;
  appRoot?.setAttribute("data-inspector", "open");
  bus.emit("inspector:open", {});

  if (dossier && typeof dossier.then === "function") {
    setTitle(title ?? "Assembling…");
    clear(body).append(loadingView());
    dossier
      .then((d) => {
        setTitle(title ?? d?.unit?.id ?? "Evidence");
        clear(body).append(renderDossier(d));
      })
      .catch((err) => {
        setTitle("Evidence");
        clear(body).append(errorView(err));
      });
  } else if (dossier) {
    setTitle(title ?? dossier?.unit?.id ?? "Evidence");
    clear(body).append(renderDossier(dossier));
  }
  host.querySelector(".inspector__close")?.focus();
}

/** Fetch a unit's dossier via the registered fetcher, then open. */
export function openUnit(unitId) {
  if (!fetcherFn) return;
  open(fetcherFn(unitId), { title: unitId });
}

export function close() {
  appRoot?.setAttribute("data-inspector", "closed");
  bus.emit("inspector:close", {});
  if (lastTrigger?.isConnected) lastTrigger.focus();
  lastTrigger = null;
}

/**
 * Delegated doors: one capture-phase listener on document opens the
 * inspector for ANY element bearing data-evidence. Comma-lists open a
 * chooser. Keyboard included free where doors are buttons; for non-button
 * doors Enter is honored here.
 */
export function initEvidenceDelegation(fetcher) {
  fetcherFn = fetcher;
  document.addEventListener("click", onDoor);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const door = e.target?.closest?.("[data-evidence]");
    if (door && door.tagName !== "BUTTON" && door.tagName !== "A") onDoor(e);
  });
  return () => document.removeEventListener("click", onDoor);
}

function onDoor(e) {
  const door = e.target?.closest?.("[data-evidence]");
  if (!door) return;
  const ids = String(door.dataset.evidence).split(/[,\s]+/).filter(Boolean);
  if (ids.length === 0) return;
  lastTrigger = door;
  // data-evidence-total: the TRUE unit count behind this door — evidence id
  // lists cap at 100 server-side, so a bare ids.length can under-claim.
  const total = Number(door.dataset.evidenceTotal);
  if (ids.length === 1 && !(Number.isFinite(total) && total > 1)) openUnit(ids[0]);
  else openList(ids, Number.isFinite(total) && total > ids.length ? total : null);
}

function openList(ids, total = null) {
  if (!host) init({});
  appRoot?.setAttribute("data-inspector", "open");
  setTitle(total ? `${ids.length} of ${total} units` : `${ids.length} units`);
  clear(body).append(
    el("p", { class: "inspector__listnote" },
      total
        ? el("span", {}, "This cell holds ", el("strong", {}, String(total)),
            " units; the first ", el("strong", {}, String(ids.length)), " are listed here. Open one:")
        : el("span", {}, "This cell lists ", el("strong", {}, String(ids.length)), " units. Open one:")),
    el("ul", { class: "inspector__unitlist", role: "list" },
      ...ids.map((id) =>
        el("li", {},
          el("button", {
            class: "inspector__unitbtn data",
            type: "button",
            onclick: () => openUnit(id),
          }, id))),
    ),
  );
  host.querySelector(".inspector__close")?.focus();
}

function setTitle(text) {
  if (titleEl) titleEl.textContent = text;
}

/* ---- the dossier ---------------------------------------------------------- */

/** Render a full evidence dossier. Exported so the gallery can pose one. */
export function renderDossier(d = {}) {
  const unit = d.unit ?? {};
  const hits = normalizeHits(d.dictionaryHits);
  const outputs = normalizeOutputs(d.outputs);
  const gold = normalizeGold(d.goldLabels);
  const level = d.level ?? null;

  const frag = el("div", { class: "dossier" });

  // 1 — the human voice
  frag.append(section("Verbatim",
    quotecard.render({
      unit,
      highlights: hits.spans,
      lang: d.lang,
      anonymized: Boolean(unit.flags?.pii?.length || d.anonymized),
    }),
  ));

  // 2 — dictionary hits
  if (hits.byCategory.length > 0) {
    frag.append(section("Dictionary",
      el("ul", { class: "dossier__dict", role: "list" },
        ...hits.byCategory.map(({ category, terms }) =>
          el("li", { class: "dossier__dict-row" },
            el("span", {
              class: "chip chip--cat",
              dataset: { cat: category, slot: String(quotecard.catSlot(category)) },
            }, category),
            el("span", { class: "dossier__dict-terms data" }, terms.join(" · ")),
          ))),
    ));
  }

  // 3 — machine readings (per juror)
  if (outputs.length > 0) {
    frag.append(section("Machine readings",
      el("ul", { class: "dossier__judges", role: "list" },
        ...outputs.map((o) => judgeRow(o, level))),
    ));
  }

  // 4 — gold
  if (gold.length > 0) {
    frag.append(section("Gold standard",
      el("ul", { class: "dossier__gold", role: "list" },
        ...gold.map((g) =>
          el("li", { class: "dossier__gold-row" },
            el("span", { class: "chip chip--gold" }, String(g.label)),
            el("span", { class: "dossier__gold-coder data" }, g.coder),
            g.adjudicated ? el("span", { class: "chip chip--ghost" }, "adjudicated") : null,
          ))),
    ));
  }

  // 5 — source position
  const pos = d.sourcePos ?? unit.pos;
  if (pos && Object.keys(pos).length > 0) {
    frag.append(section("Source",
      el("p", { class: "dossier__pos data" }, describePos(pos)),
    ));
  }

  if (hits.byCategory.length === 0 && outputs.length === 0 && gold.length === 0) {
    frag.append(el("p", { class: "dossier__none" },
      "No instrument has read this unit yet. Numbers that cite it will list their readings here."));
  }

  return frag;
}

function section(label, ...children) {
  return el("section", { class: "dossier__section" },
    el("h3", { class: "overline dossier__label" }, label),
    ...children,
  );
}

function judgeRow(o, level) {
  const conf = typeof o.confidence === "number" ? o.confidence : null;
  return el("li", { class: "dossier__judge" },
    el("div", { class: "dossier__judge-head" },
      el("span", { class: "chip chip--machine" }, String(o.label ?? "—")),
      el("span", { class: "dossier__judge-name data" }, shortJuror(o.juror)),
      conf !== null
        ? el("span", { class: "dossier__judge-conf data", title: "Judge-reported confidence" },
            "conf ", fmtStat(conf),
            level ? ladder.render({ level, size: "sm" }) : null,
            el("span", {
              class: "confbar",
              aria: { hidden: "true" },
              style: { "--conf": `${Math.round(conf * 100)}%` },
            }))
        : null,
      o.escalated ? el("span", { class: "chip chip--signal" }, "escalated") : null,
      o.repaired ? el("span", { class: "chip chip--ghost" }, "repaired") : null,
    ),
    o.rationale ? el("p", { class: "dossier__rationale" }, o.rationale) : null,
  );
}

function shortJuror(juror) {
  if (!juror) return "judge";
  const s = String(juror);
  return s.length > 18 ? s.slice(0, 10) + "…" + s.slice(-4) : s;
}

function describePos(pos) {
  const parts = [];
  if (pos.doc) parts.push(`doc ${pos.doc}`);
  if (pos.row !== undefined && pos.row !== null) parts.push(`row ${pos.row}`);
  if (pos.para !== undefined && pos.para !== null) parts.push(`¶ ${pos.para}`);
  if (pos.turn !== undefined && pos.turn !== null) parts.push(`turn ${pos.turn}`);
  if (pos.speaker) parts.push(String(pos.speaker));
  if (pos.span) parts.push(`chars ${pos.span[0]}–${pos.span[1]}`);
  return parts.join(" · ") || "—";
}

/* Tolerant shapes for dictionaryHits:
   - LIVE dossiers carry per-instrument wrappers
       [{instrumentId, name, hits: [{category, term, start, end}]}]
     → unwrap: spans keep their category (highlight colors), and the
     Dictionary list groups under the INSTRUMENT NAME as its label.
   - bare span arrays [{category, term, start, end}] (the gallery poses
     these) group by hit category as before;
   - {category: [terms]} summaries render terms without spans. */
function normalizeHits(raw) {
  const spans = [];
  const byCat = new Map(); // group label → Set(terms)
  const addTerm = (label, term) => {
    if (!byCat.has(label)) byCat.set(label, new Set());
    if (term) byCat.get(label).add(term);
  };
  const addSpan = (h) => {
    if (typeof h.start === "number" && typeof h.end === "number") {
      spans.push({ start: h.start, end: h.end, category: h.category, kind: "dict" });
    }
  };
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (h && Array.isArray(h.hits)) {
        // live wrapper — one group per dictionary instrument
        const label = h.name ?? h.instrumentId ?? "dictionary";
        for (const hit of h.hits) {
          addSpan(hit);
          addTerm(label, hit.term);
        }
        continue;
      }
      // bare span (gallery) — group by the hit's category
      addSpan(h);
      addTerm(h.category ?? "match", h.term);
    }
  } else if (raw && typeof raw === "object") {
    for (const [cat, terms] of Object.entries(raw)) {
      byCat.set(cat, new Set(Array.isArray(terms) ? terms : [String(terms)]));
    }
  }
  return {
    spans,
    byCategory: [...byCat.entries()]
      .filter(([, terms]) => terms.size > 0)
      .map(([category, terms]) => ({ category, terms: [...terms] })),
  };
}

/* Live dossiers group machine readings by run: [{runId, instrumentId,
   status, model, outputs: [juror lines]}]. Flatten to juror lines for the
   Machine readings list; bare juror-line arrays (gallery) pass through. */
function normalizeOutputs(raw) {
  if (!Array.isArray(raw)) return [];
  const flat = [];
  for (const o of raw) {
    if (o && Array.isArray(o.outputs)) {
      for (const line of o.outputs) flat.push({ ...line, runId: o.runId });
    } else if (o) {
      flat.push(o);
    }
  }
  return flat;
}

/* Live goldLabels are per-goldset entries [{goldsetId, tier, status,
   coders: {coderId: label}, adjudicated}] → one row per coder plus the
   adjudicated verdict. Bare rows and {coder: label} maps stay tolerated. */
function normalizeGold(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const rows = [];
    for (const g of raw) {
      if (g && g.coders && typeof g.coders === "object") {
        for (const [coder, label] of Object.entries(g.coders)) rows.push({ coder, label });
        if (g.adjudicated !== null && g.adjudicated !== undefined) {
          rows.push({ coder: "adjudicated", label: g.adjudicated, adjudicated: true });
        }
        continue;
      }
      rows.push({ coder: g.coder ?? g.coderId ?? "coder", label: g.label, adjudicated: g.adjudicated });
    }
    return rows;
  }
  return Object.entries(raw).map(([coder, label]) =>
    coder === "adjudicated"
      ? { coder: "adjudicated", label, adjudicated: true }
      : { coder, label });
}

function loadingView() {
  return el("div", { class: "dossier__loading" },
    el("p", { class: "muted" }, "Assembling evidence…"));
}

function errorView(err) {
  return el("div", { class: "dossier__error" },
    el("p", {}, "The evidence could not be loaded."),
    el("p", { class: "faint data" }, String(err?.message ?? err)));
}
