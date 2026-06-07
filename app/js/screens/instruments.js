// Instruments — #/p/:slug/instruments[/:id] — where constructs become
// measurement. List grouped by construct with ladder marks; three editors:
//   dictionary — term chips per category, weights, negation toggle+window,
//                live highlighted preview against sample units;
//   judge      — compiled prompt with slot highlighting, workerClass, model
//                picker from the catalog, params, "Edit raw" escape hatch;
//   panel      — juror cards with family chips, live cost-per-1k, the
//                family-disjointness warning, aggregation in plain language.
// A scope bar under the pipeline strip states what the editor reads (corpus ·
// text column · units) and, with several corpora, carries the selector that
// every preview/check obeys.
// Actions: Compile (Director), Silver-tune (SSE iteration cards + sparkline),
// Stability check, Preview on 5 sample units, Freeze (→ certificate sheet).
//
// The construct → instrument handoff is ONE click: arriving with
// ?construct=<id>&compile=1 and no instrument for that construct opens the
// compile sheet directly — construct preselected, model defaulted to the
// project Director's provider/model — so the user lands IN the action.

import { el, clear, frag } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import { cite } from "../components/cite.js";
import * as glyph from "../components/glyph.js";
import * as ladderC from "../components/ladder.js";
import * as pipeline from "../components/pipeline.js";
import * as quotecard from "../components/quotecard.js";
import * as modelpicker from "../components/modelpicker.js";
import * as scopechip from "../components/scopechip.js";
import { contextLine, corpusText } from "../components/contextline.js";
import * as line from "../components/charts/line.js";
import { fmt, fmtStat, fmtCost, fmtCount, fmtDateTime } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, refreshProject, emptyState, openSheet, sheetBusy, buttonBusy, kv, kvList, markedValue, normalizeQuarantine } from "./_shared.js";

export const route = "p/:slug/instruments";
export const routes = ["p/:slug/instruments", "p/:slug/instruments/:id"];
export const title = "Instruments";

const AGG_RULES = {
  majority: "The label most jurors chose wins. Ties flag for escalation.",
  mean: "Numeric labels average; the panel reads as one smoother judge.",
  median: "The middle numeric label — robust to one juror's wild read.",
  unanimityOrFlag: "Agreement or nothing: any split flags the unit for review.",
  confidenceWeighted: "Votes weighted by each juror's self-reported confidence.",
  reliabilityWeighted: "Votes weighted by each juror's measured agreement with silver or gold.",
};

/* The first few units of the CHOSEN corpus serve as the live preview sample. */
async function sampleUnits(slug, corpus, n = 5) {
  if (!corpus?.id) return [];
  const page = await api.corpora.units(slug, corpus.id, { limit: n }).catch(() => null);
  return page?.units ?? [];
}

/* Which corpus previews read. Default: the MOST RECENTLY CREATED one —
   re-unitized variants ("… · text=<col>") append to project.corpora, so a
   fresh re-unitization is what previews pick up unless changed in the scope
   bar at the top of the editor. One scope per editor: the dictionary live
   preview, Preview, Silver-tune, and Stability all read the bar's selection. */
function makePreviewScope(project) {
  const corpora = project?.corpora ?? [];
  const listeners = new Set();
  return {
    corpora,
    corpusId: corpora.at(-1)?.id ?? null,
    corpus() { return corpora.find((c) => c.id === this.corpusId) ?? null; },
    set(id) { this.corpusId = id; for (const fn of listeners) fn(); },
    onChange(fn) { listeners.add(fn); },
  };
}

function textColumnOf(corpus) {
  return corpus?.textColumn ?? corpus?.unitization?.textColumn ?? null;
}

/* The ONE context line of the editor, directly under its title: `measures
   <construct →> · reads <corpus — text: col · units>`. The reads slot IS the
   editor's scope: with several corpora it is a select (option labels carry
   the same facts); with one, plain text. Everything that reads units — the
   dictionary live preview, Preview, Silver-tune, Stability — obeys it. */
function editorContextLine(params, inst, construct, previewScope) {
  const corpora = previewScope?.corpora ?? [];
  const corpus = previewScope?.corpus() ?? null;
  let readsPart;
  if (corpora.length > 1) {
    readsPart = {
      label: "reads",
      node: el("select", {
        class: "input input--inline readscope__select",
        "aria-label": "Corpus the previews and checks read — picking a corpus picks the text column",
        onchange: (e) => previewScope.set(e.target.value),
      }, ...corpora.map((c) =>
        el("option", { value: c.id, selected: c.id === previewScope.corpusId }, scopechip.optionLabel(c)))),
    };
  } else if (corpus) {
    readsPart = { label: "reads", text: corpusText(corpus) };
  } else {
    readsPart = { label: "reads", text: "no corpus yet — import one to preview", href: `#/p/${params.slug}/import` };
  }
  return el("div", { class: "readscope" },
    contextLine([
      construct
        ? { label: "measures", text: construct.name, href: `#/p/${params.slug}/constructs/${construct.id}` }
        : { label: "measures", text: inst.constructId ?? "construct not recorded", faint: true },
      readsPart,
    ]),
    el("p", { class: "screen__hint faint readscope__hint" },
      "An instrument reads a corpus's unit text — previews and checks below read this one. To measure a different column, re-unitize the corpus on that column (Instant Read → change)."));
}

/* The one line every preview result opens with — what was read, from where. */
function readLine(corpus, n) {
  return el("p", { class: "screen__hint faint" },
    "Read ", el("span", { class: "data" }, fmtCount(n)),
    " units from ", el("span", { class: "data" }, corpus ? scopechip.displayName(corpus) : "—"),
    " (text: ", el("span", { class: "data" }, textColumnOf(corpus) ?? "not recorded"), ").");
}

/* Failed units are never an empty space. The preview envelope's quarantine
   ({unitId, code, message}; bare ids from older servers) renders as a signal
   panel ABOVE any successful rows — identical code+message pairs group, each
   distinct reason shows once with its count, and when EVERY unit failed this
   panel IS the result. Returns null when nothing failed. Exported (like
   localHits) so the copy stays testable. */
export function failurePanel(quarantine, total) {
  const entries = normalizeQuarantine(quarantine);
  if (!entries.length) return null;
  const n = entries.length;

  const groups = new Map();
  for (const e of entries) {
    const key = `${e.code ?? ""}|${e.message ?? ""}`;
    const g = groups.get(key) ?? { code: e.code, message: e.message, count: 0 };
    g.count += 1;
    groups.set(key, g);
  }
  const reasons = [...groups.values()];
  const reasonText = (g) => [g.code, g.message].filter(Boolean).join(": ");

  const head = el("p", { class: "failpanel__head" },
    el("strong", {}, total !== null && total !== undefined
      ? `${fmtCount(n)} of ${fmtCount(total)} units failed`
      : `${fmtCount(n)} unit${n === 1 ? "" : "s"} failed`));
  // one reason → it joins the headline; several → one line each, with counts
  if (reasons.length === 1 && reasonText(reasons[0])) {
    head.append(" — ", reasonText(reasons[0]));
  } else if (reasons.length === 1) {
    head.append(" — ", el("span", { class: "faint" }, "no failure reasons recorded (older server)"));
  }

  return el("div", { class: "failpanel", role: "alert" },
    head,
    reasons.length > 1
      ? el("ul", { class: "failpanel__lines", role: "list" },
          ...reasons.map((g) => el("li", { class: "failpanel__line" },
            el("span", { class: "data failpanel__count" }, `×${fmtCount(g.count)}`),
            " ",
            reasonText(g) || el("span", { class: "faint" }, "no failure reason recorded (older server)"))))
      : null,
    entries.some((e) => e.code === "TRUNCATED")
      ? el("p", { class: "failpanel__hint" },
          "Raise max tokens in the Worker parameters — reasoning models spend thinking tokens against the same budget.")
      : null);
}

export function render(mount, params, query = {}) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const [instruments, constructs, catalogRes] = await Promise.all([
      api.instruments.list(params.slug),
      api.constructs.list(params.slug).catch(() => []),
      api.catalog.models().catch(() => ({ providers: {} })),
    ]);
    // live catalog envelope: {providers: {name: [models]}, cachedAt}
    return { project, instruments, constructs, catalog: catalogRes?.providers ?? {} };
  }, ({ project, instruments, constructs, catalog }) => {
    let selected = params.id ? instruments.find((i) => i.id === params.id) : null;
    // the constructs editor links here as instruments?construct=<id> after a
    // save — preselect that construct's first instrument when one exists
    if (!selected && !params.id && query?.construct) {
      selected = instruments.find((i) => i.constructId === query.construct) ?? null;
    }

    const openCompile = (presetConstructId = null) =>
      compileSheet(params, { project, constructs, catalog, presetConstructId });

    mount.append(screenHead({
      overline: "Instruments",
      title: "How the constructs get measured.",
      lede: "An instrument is a concrete way of measuring one construct: compile it, preview it on a few units, then run it over the corpus.",
      actions: [
        el("button", { class: "btn btn--primary", type: "button", onclick: () => openCompile(query?.construct ?? null) }, "New instrument…"),
      ],
    }));

    mount.append(el("p", { class: "screen__intro" },
      "A ", el("strong", {}, "judge"), " is a model given your codebook as instructions. A ",
      el("strong", {}, "dictionary"), " is a transparent term list — instant and free. A ",
      el("strong", {}, "panel"), " is several judges that vote. Most studies start by compiling a judge from a construct."));

    // ?construct=<id>&compile=1 with no instrument for that construct yet →
    // open the compile flow directly, preselected (the one-click handoff).
    // compile=new opens it even when instruments exist — the "+ same
    // construct, another model" door from the Reliability home.
    if (!params.id && query?.construct
        && (query?.compile === "new"
          || (query?.compile === "1" && !instruments.some((i) => i.constructId === query.construct)))) {
      openCompile(query.construct);
    }

    const split = el("div", { class: "split" });
    mount.append(split);

    /* -- list grouped by construct -- */
    const list = el("nav", { class: "split__list", aria: { label: "Instruments" } });
    if (!instruments.length) {
      list.append(emptyState({
        title: "No instruments yet.",
        body: "Pick a construct and compile a judge from it — the Director turns the codebook into a prompt you review before anything runs.",
        actions: [
          constructs.length
            ? el("button", { class: "btn btn--primary", type: "button", onclick: () => openCompile(query?.construct ?? null) }, "Compile a judge…")
            : el("a", { class: "btn btn--primary", href: `#/p/${params.slug}/constructs` }, "Write a construct first"),
        ],
      }));
    } else {
      const byConstruct = new Map();
      for (const inst of instruments) {
        const key = inst.constructId ?? "—";
        if (!byConstruct.has(key)) byConstruct.set(key, []);
        byConstruct.get(key).push(inst);
      }
      for (const [cid, group] of byConstruct) {
        const construct = constructs.find((c) => c.id === cid);
        list.append(el("h3", { class: "overline split__group" }, construct?.name ?? cid));
        for (const inst of group) {
          list.append(el("a", {
            class: `listitem${selected?.id === inst.id ? " listitem--active" : ""}`,
            href: `#/p/${params.slug}/instruments/${inst.id}`,
            aria: { current: selected?.id === inst.id ? "true" : null },
          },
            el("span", { class: "listitem__name" },
              inst.name,
              glyph.render({ authoredBy: inst.authoredBy, humanTouched: inst.humanTouched ?? true })),
            el("span", { class: "listitem__meta" },
              el("span", { class: "chip" }, inst.kind),
              ladderC.render({ level: inst.level, size: "sm" }),
              inst.frozen ? el("span", { class: "chip chip--ghost" }, "frozen") : null),
          ));
        }
      }
    }
    split.append(list);

    /* -- editor -- */
    const main = el("div", { class: "split__main" });
    split.append(main);
    if (!selected) {
      const wanted = query?.construct ? constructs.find((c) => c.id === query.construct) : null;
      main.append(emptyState(wanted
        ? {
            title: `No instrument measures “${wanted.name}” yet.`,
            body: "Compile a judge from it — the Director turns the construct's definition, criteria, and examples into a prompt you review before anything runs.",
            actions: [el("button", { class: "btn btn--primary", type: "button", onclick: () => openCompile(wanted.id) }, `Compile a judge for “${wanted.name}”`)],
          }
        : {
            title: instruments.length ? "Pick an instrument from the list." : "Nothing to edit yet.",
            body: "Each instrument measures one construct. Open one to edit and test it, or compile a new one from a construct.",
          }));
      return;
    }
    instrumentEditor(main, params, selected, constructs, catalog, project);
  }, "Opening the instrument bench…");
}

/* ================= editor ========================================================= */

function instrumentEditor(main, params, instRaw, constructs, catalog, project = null) {
  const inst = JSON.parse(JSON.stringify(instRaw));
  const construct = constructs.find((c) => c.id === inst.constructId);
  const previewScope = makePreviewScope(project);
  let dirty = false;

  /* -- pipeline strip: where this instrument sits, and the ONE next step.
     Preview is ephemeral (never persisted), so "previewed" is session truth:
     the strip advances the moment the preview action runs. -- */
  let previewed = false;
  const stripHost = el("div", {});
  main.append(stripHost);
  let actions = null; // set below; the strip's preview action drives it
  // the Calibrate stage's companion reading door — every agreement statistic
  // for this construct (humans, gold, instruments, retest) in one matrix
  const reliabilityHref = `#/p/${params.slug}/reliability/${encodeURIComponent(inst.constructId)}`;
  const paintStrip = () => {
    const level = ladderC.levelKey(inst.level);
    const hasCompleteRun = (project?.runs ?? []).some((r) => r.instrumentId === inst.id && r.status === "complete");
    const states = { construct: "done" };
    const calibrateAction = {
      label: "Calibrate against gold →",
      onclick: (e) => openGoldFlow(e, params, inst, project, previewScope),
    };
    const companion = {
      label: "Reliability →",
      href: reliabilityHref,
      title: "Every reading of this construct and how much the readers agree — κ, α, and the gold anchor live here",
    };
    let action;
    let secondary = null;
    if (inst.frozen || level === "calibrated" || level === "corrected") {
      states.instrument = "done";
      states.calibrate = "done";
      if (hasCompleteRun) states.run = "done";
      action = hasCompleteRun
        ? { label: "Correct in the Workbench →", href: `#/p/${params.slug}/analyses` }
        : { label: "Run on the corpus →", href: `#/p/${params.slug}/runs?preflight=${encodeURIComponent(inst.id)}` };
    } else if (level === "stabilized") {
      states.instrument = "done";
      if (hasCompleteRun) states.run = "done";
      action = calibrateAction;
    } else if (previewed) {
      // levels never block: gold is one click away even at ◌
      action = { label: "Run on the corpus →", href: `#/p/${params.slug}/runs?preflight=${encodeURIComponent(inst.id)}` };
      secondary = calibrateAction;
    } else {
      action = { label: "Preview on 5 units", onclick: () => actions?.clickPreview() };
      secondary = calibrateAction;
    }
    clear(stripHost).append(pipeline.render({ current: "instrument", states, action, secondary, companion }));
  };

  const saveBtn = el("button", {
    class: "btn btn--primary", type: "button", disabled: true,
    onclick: async () => {
      saveBtn.disabled = true;
      try {
        await api.instruments.update(params.slug, inst.id, inst);
        toast.success("Instrument saved.", { detail: "edits reset its evidence level to ◌ — run Stability check or calibrate against gold to restore it" });
        dirty = false;
      } catch (err) {
        saveBtn.disabled = false;
        toast.error("Save failed.", { detail: String(err.message ?? err) });
      }
    },
  }, "Save");

  const touch = () => {
    if (inst.frozen) return; // read-only — UI below disables inputs too
    dirty = true;
    inst.humanTouched = true;
    saveBtn.disabled = false;
  };

  main.append(el("header", { class: "editor__head" },
    el("div", {},
      el("h3", { class: "editor__title" },
        inst.name,
        glyph.render({ authoredBy: inst.authoredBy, humanTouched: inst.humanTouched ?? true })),
      el("p", { class: "editor__sub" },
        el("span", { class: "chip" }, inst.kind),
        ladderC.render({ level: inst.level, size: "sm", label: true }),
        el("span", { class: "chip data" }, `v${inst.version}`),
        el("span", { class: "chip chip--ghost data", title: "Content-addressed version hash" }, String(inst.versionHash ?? "").slice(0, 10)),
        inst.stability
          ? el("a", {
              class: "chip data",
              href: reliabilityHref,
              title: `Test–retest stability: k = ${inst.stability.k} reruns on ${inst.stability.n} units — open the construct's reliability matrix`,
            }, `stability α ${fmtStat(inst.stability.alpha)}`)
          : null,
        inst.frozen ? el("span", { class: "chip chip--gold" }, "frozen — edits fork") : null)),
    el("div", { class: "editor__headactions" }, saveBtn),
  ));

  /* -- context: what this instrument measures and what it reads, in ONE
     line under the title; every preview/check below obeys its scope. -- */
  main.append(editorContextLine(params, inst, construct, previewScope));

  if (inst.frozen) {
    main.append(el("p", { class: "screen__hint annotation annotation--still" },
      "This instrument is frozen at ● — its certificate is the contract. Any edit forks a new ◌ version with this one as parent."));
  }

  /* -- kind-specific editor -- */
  if (inst.kind === "dictionary") dictionaryEditor(main, params, inst, touch, () => dirty, previewScope);
  else if (inst.kind === "judge") judgeEditor(main, params, inst, catalog, construct, touch);
  else if (inst.kind === "panel") panelEditor(main, params, inst, catalog, touch);

  /* -- certificate (frozen) -- */
  if (inst.certificate) {
    main.append(section("Calibration certificate", certificateCard(inst.certificate, { reliabilityHref })));
  }

  /* -- silver curve, if any -- */
  if (inst.silver?.iterations?.length) {
    main.append(section("Silver-tuning history", silverCurve(inst.silver.iterations)));
  }

  /* -- actions -- */
  actions = actionRow(main, params, inst, {
    onPreviewed: () => { previewed = true; paintStrip(); },
    previewScope,
    construct,
  });
  main.append(section("Actions", actions.el));
  paintStrip();
}

/* The calibration step at any level: open the construct's gold set, creating
   one (status: sampling) when none exists — scoped to the editor's current
   corpus — so the click lands in the studio's Sample pane rather than on
   advice. */
async function openGoldFlow(e, params, inst, project, previewScope = null) {
  const existing = (project?.goldsets ?? []).find((g) => g.constructId === inst.constructId);
  if (existing) {
    router.navigate(`p/${params.slug}/goldsets/${existing.id}`);
    return;
  }
  const btn = e?.target;
  if (btn) btn.disabled = true;
  try {
    const created = await api.goldsets.create(params.slug, {
      constructId: inst.constructId,
      corpusId: previewScope?.corpusId ?? undefined,
    });
    toast.success("Gold set created.", { detail: "draw the sample, then code it blind", data: false });
    await refreshProject(params.slug).catch(() => {});
    router.navigate(`p/${params.slug}/goldsets/${created.id}`);
  } catch (err) {
    if (btn) btn.disabled = false;
    toast.error("Could not open the calibration flow.", { detail: String(err.message ?? err) });
  }
}

/* ================= dictionary ====================================================== */

function dictionaryEditor(main, params, inst, touch, isDirty = () => false, previewScope = null) {
  const payload = inst.payload ?? (inst.payload = { categories: [], negation: { enabled: false, window: 3 }, scoring: "percentOfWords" });
  const ro = inst.frozen;

  /* categories of term chips */
  const catWrap = el("div", { class: "dictcats" });
  const redraw = () => {
    clear(catWrap);
    payload.categories.forEach((cat, ci) => {
      const slot = String(quotecard.catSlot(cat.name));
      const chips = el("div", { class: "termchips" },
        ...cat.terms.map((t, ti) =>
          el("span", { class: "termchip chip chip--cat", dataset: { slot } },
            el("span", { class: "termchip__term" }, t.term),
            t.weight !== undefined && t.weight !== 1 ? el("span", { class: "termchip__weight data" }, `×${t.weight}`) : null,
            !ro ? el("button", {
              class: "termchip__x", type: "button", aria: { label: `Remove term ${t.term}` },
              onclick: () => { cat.terms.splice(ti, 1); touch(); redraw(); schedulePreview(); },
            }, "×") : null)),
        !ro ? el("input", {
          class: "input termchips__add", placeholder: "+ term, underpa*, \"exact phrase\"",
          "aria-label": `Add term to ${cat.name}`,
          onkeydown: (e) => {
            if (e.key !== "Enter" || !e.target.value.trim()) return;
            cat.terms.push({ term: e.target.value.trim() });
            e.target.value = "";
            touch(); redraw(); schedulePreview();
          },
        }) : null,
      );
      catWrap.append(el("div", { class: "dictcat" },
        el("div", { class: "dictcat__head" },
          el("span", { class: "chip chip--cat", dataset: { slot } }, cat.name),
          el("span", { class: "faint data" }, `${cat.terms.length} terms`),
          !ro ? el("button", {
            class: "btn btn--quiet", type: "button", aria: { label: `Remove category ${cat.name}` },
            onclick: () => { payload.categories.splice(ci, 1); touch(); redraw(); schedulePreview(); },
          }, "×") : null),
        chips));
    });
    if (!ro) {
      catWrap.append(el("button", {
        class: "btn btn--quiet", type: "button",
        onclick: () => {
          const name = prompt("Category name:");
          if (name) { payload.categories.push({ name, terms: [] }); touch(); redraw(); }
        },
      }, "+ add category"));
    }
  };
  redraw();
  main.append(section("Term lists", catWrap));

  /* negation + scoring */
  const negWindow = el("input", {
    class: "input input--num", type: "number", min: 1, max: 8,
    value: payload.negation?.window ?? 3, disabled: ro || !payload.negation?.enabled,
    "aria-label": "Negation window in tokens",
    onchange: (e) => { payload.negation.window = Number(e.target.value); touch(); schedulePreview(); },
  });
  main.append(section("Scoring",
    el("div", { class: "controlrow" },
      el("label", { class: "switch" },
        el("input", {
          type: "checkbox", checked: Boolean(payload.negation?.enabled), disabled: ro,
          onchange: (e) => {
            payload.negation = payload.negation ?? { window: 3 };
            payload.negation.enabled = e.target.checked;
            negWindow.disabled = ro || !e.target.checked;
            touch(); schedulePreview();
          },
        }),
        el("span", {}, "Negation flips polarity")),
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "window ±"), negWindow,
        el("span", { class: "faint data" }, "tokens")),
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "scoring"),
        el("select", {
          class: "input input--inline", disabled: ro, "aria-label": "Scoring mode",
          onchange: (e) => { payload.scoring = e.target.value; touch(); schedulePreview(); },
        },
          ...["percentOfWords", "count", "binary"].map((m) =>
            el("option", { value: m, selected: payload.scoring === m }, m)))),
    )));

  /* live highlighted preview */
  const previewWrap = el("div", { class: "dictpreview", aria: { live: "polite" } });
  main.append(section("Live preview — sample units", previewWrap));

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 350);
  }
  previewScope?.onChange(schedulePreview); // the scope bar's corpus selection re-aims this preview too
  async function runPreview() {
    // Saved instruments preview server-side — POST instruments/:i/preview →
    // {outputs, cost, quarantine, missing}; dictionary outputs carry hit
    // spans ({category, term, start, end}) and per-category scores. UNSAVED
    // edits preview through the local matcher instead (the server only knows
    // the saved payload) and say so: "draft preview".
    const draft = !ro && isDirty() === true;
    clear(previewWrap).append(el("p", { class: "faint" }, draft ? "scoring the draft locally…" : "previewing…"));
    try {
      const corpus = previewScope?.corpus() ?? null;
      const units = await sampleUnits(params.slug, corpus, 5);
      const res = draft || units.length === 0
        ? null
        : await api.instruments.preview(params.slug, inst.id, { unitIds: units.map((u) => u.id), corpusId: corpus?.id ?? undefined }).catch(() => null);
      const outputs = res?.outputs ?? [];
      clear(previewWrap);
      if (!units.length) {
        previewWrap.append(el("p", { class: "faint" },
          `No sample units available${corpus ? ` in ${scopechip.displayName(corpus)}` : ""}.`));
        return;
      }
      previewWrap.append(readLine(corpus, units.length));
      // failures above any successful rows; quarantined units leave the row
      // list — when all of them failed, the panel is the whole result
      const failed = draft ? null : failurePanel(res?.quarantine, units.length);
      if (failed) previewWrap.append(failed);
      const quarantined = new Set(draft ? [] : normalizeQuarantine(res?.quarantine).map((q) => q.unitId));
      if (draft) {
        previewWrap.append(el("p", { class: "dictpreview__draftnote faint" },
          el("span", { class: "chip chip--ghost" }, "draft preview"),
          " local matcher over unsaved edits — save to preview the server's scoring"));
      }
      for (const unit of units) {
        if (quarantined.has(unit.id)) continue;
        const out = draft ? null : outputs.find((o) => o.unitId === unit.id && o.label !== undefined);
        const hits = draft ? localHits(unit.text, inst.payload) : out?.hits ?? [];
        previewWrap.append(el("div", { class: "dictpreview__row" },
          quotecard.render({ unit, highlights: hits, compact: true, evidence: true }),
          out?.scores
            ? el("p", { class: "dictpreview__scores data" },
                Object.entries(out.scores).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${fmt(v, 1)}%`).join(" · ") || "no hits")
            : null,
        ));
      }
    } catch (err) {
      clear(previewWrap).append(el("p", { class: "faint" }, "Preview unavailable: ", String(err.message ?? err)));
    }
  }
  runPreview();
}

/* naive local matcher — keeps the preview live even before the server answers */
export function localHits(text, payload) {
  const hits = [];
  const lower = String(text).toLowerCase();
  for (const cat of payload?.categories ?? []) {
    for (const { term } of cat.terms ?? []) {
      let t = String(term).toLowerCase().replace(/^"|"$/g, "");
      const prefix = t.endsWith("*");
      if (prefix) t = t.slice(0, -1);
      if (!t) continue;
      let idx = 0;
      while ((idx = lower.indexOf(t, idx)) !== -1) {
        const before = idx === 0 ? " " : lower[idx - 1];
        const afterIdx = idx + t.length;
        const after = afterIdx >= lower.length ? " " : lower[afterIdx];
        const boundaryBefore = !/[a-z0-9]/.test(before);
        const boundaryAfter = prefix || !/[a-z0-9]/.test(after);
        if (boundaryBefore && boundaryAfter) {
          let end = afterIdx;
          if (prefix) while (end < lower.length && /[a-z0-9'-]/.test(lower[end])) end += 1;
          hits.push({ start: idx, end, category: cat.name });
        }
        idx = afterIdx;
      }
    }
  }
  return hits;
}

/* ================= judge ============================================================ */

function judgeEditor(main, params, inst, catalog, construct, touch) {
  const payload = inst.payload ?? (inst.payload = {});
  const ro = inst.frozen;

  /* compiled prompt with slot highlighting */
  const promptView = el("pre", { class: "promptview", tabindex: "0", aria: { label: "Compiled prompt template" } });
  const paintPrompt = () => {
    clear(promptView);
    const tpl = String(payload.promptTemplate ?? "");
    const re = /\{\{(definition|criteria|examples|unit)\}\}/g;
    let last = 0, m;
    while ((m = re.exec(tpl)) !== null) {
      if (m.index > last) promptView.append(tpl.slice(last, m.index));
      promptView.append(el("mark", { class: `promptslot promptslot--${m[1]}` }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < tpl.length) promptView.append(tpl.slice(last));
  };
  paintPrompt();

  const rawArea = el("textarea", {
    class: "input textarea promptraw", rows: 12, disabled: ro,
    "aria-label": "Raw prompt template",
    oninput: (e) => { payload.promptTemplate = e.target.value; touch(); paintPrompt(); },
  }, payload.promptTemplate ?? "");
  const rawReveal = el("details", { class: "rawreveal" },
    el("summary", { class: "rawreveal__summary" }, "Edit raw template"),
    el("p", { class: "screen__hint faint" }, "The compiled view is the contract; this is the escape hatch. Slots ", el("code", {}, "{{definition}} {{criteria}} {{examples}} {{unit}}"), " fill from the construct at run time."),
    rawArea);

  main.append(section("Compiled prompt",
    el("p", { class: "screen__hint faint" },
      "Compiled from ", el("strong", {}, construct?.name ?? inst.constructId),
      " — slots highlight where the codebook pours in."),
    promptView,
    rawReveal));

  /* worker class + model picker + params with capability honesty */
  const picker = modelpicker.render({
    catalog,
    value: { provider: payload.provider, model: payload.model },
    structuredFilter: true,
    disabled: ro,
    label: "Model",
    onPick: ({ provider, entry }) => {
      payload.provider = provider;
      payload.model = entry.id;
      payload.snapshot = entry.snapshot ?? null;
      touch();
      paintParams();
    },
  });

  const paramsHost = el("div", {});
  const paintParams = () => {
    const entry = modelpicker.findEntry(catalog, payload.provider, payload.model);
    // frag() skips the null branch below; NATIVE append would stringify it
    // into a literal "null" between the controls and the snapshot line
    clear(paramsHost).append(frag(
      el("div", { class: "controlrow" },
        paramControl("temperature", el("input", {
          class: "input input--num", type: "number", step: "0.1", min: 0, max: 2, disabled: ro,
          value: payload.params?.temperature ?? 0, "aria-label": "Temperature",
          onchange: (e) => { payload.params = payload.params ?? {}; payload.params.temperature = Number(e.target.value); touch(); },
        }), modelpicker.supportsParam(entry, "temperature")),
        paramControl("max tokens", el("input", {
          class: "input input--num", type: "number", step: "50", min: 50, disabled: ro,
          value: payload.params?.maxTokens ?? 400, "aria-label": "Max tokens",
          onchange: (e) => { payload.params = payload.params ?? {}; payload.params.maxTokens = Number(e.target.value); touch(); },
        }), modelpicker.supportsParam(entry, "maxTokens")),
      ),
      (!entry || !Array.isArray(entry.params))
        ? el("p", { class: "screen__hint faint" }, "Parameter support varies by model; unsupported settings are ignored by the provider.")
        : null,
      el("p", { class: "screen__hint faint data" },
        `snapshot: ${payload.snapshot ?? "unpinned"} · rationale-first: ${payload.rationaleFirst !== false ? "yes" : "no"} · schema: ${payload.schema?.type ?? "—"}${payload.schema?.options ? ` (${payload.schema.options.join(", ")})` : ""}`),
    ));
  };
  paintParams();

  main.append(section("Worker",
    el("div", { class: "controlrow" },
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "class"),
        el("select", {
          class: "input input--inline", disabled: ro, "aria-label": "Worker class",
          onchange: (e) => { payload.workerClass = e.target.value; touch(); },
        },
          ...["frontier", "mid", "small"].map((c) =>
            el("option", { value: c, selected: payload.workerClass === c }, c))),
        el("span", { class: "faint" }, "smaller classes get more rubric anchoring when the Director compiles")),
      el("div", { class: "controlrow__item controlrow__item--grow" },
        el("span", { class: "overline" }, "model"), picker.el),
    ),
    paramsHost));
}

/* A parameter control that says when the selected model ignores it — grayed,
   never hidden: the value still saves; the provider strips what it cannot use. */
function paramControl(labelText, input, supported) {
  const ignored = supported === false;
  return el("div", { class: `paramctl${ignored ? " paramctl--ignored" : ""}` },
    el("label", { class: "controlrow__item" },
      el("span", { class: "overline" }, labelText), input),
    ignored ? el("p", { class: "paramctl__note" }, "ignored by this model (reasoning-class)") : null);
}

/* ================= panel ============================================================ */

function panelEditor(main, params, inst, catalog, touch) {
  const payload = inst.payload ?? (inst.payload = { jurors: [], aggregation: "majority" });
  const ro = inst.frozen;
  const allModels = Object.entries(catalog ?? {}).flatMap(([provider, models]) =>
    (models ?? []).map((m) => ({ ...m, provider })));

  const warnBox = el("div", { class: "panelwarn", aria: { live: "polite" } });
  const costLine = el("p", { class: "panelcost data", aria: { live: "polite" } });
  const paramsNote = el("p", { class: "screen__hint faint" });
  const jurorWrap = el("div", { class: "jurors" });

  const redraw = () => {
    clear(jurorWrap);
    payload.jurors.forEach((j, i) => {
      const entry = modelpicker.findEntry(catalog, j.provider, j.model);
      const noTemp = modelpicker.supportsParam(entry, "temperature") === false;
      jurorWrap.append(el("div", { class: "juror" },
        el("div", { class: "juror__head" },
          el("span", { class: "juror__name data" }, j.model),
          el("span", { class: "chip" }, j.family ?? familyOf(j)),
          el("span", { class: "chip chip--ghost" }, j.provider),
          ...modelpicker.capBadges(entry)),
        el("p", { class: "juror__meta faint data" }, j.snapshot ?? "unpinned"),
        el("p", { class: "juror__meta faint data" },
          `temperature ${j.params?.temperature ?? 0} · max ${j.params?.maxTokens ?? 400} tokens`),
        noTemp ? el("p", { class: "paramctl__note" }, "temperature ignored by this model (reasoning-class)") : null,
        !ro ? el("button", {
          class: "btn btn--quiet juror__remove", type: "button", aria: { label: `Remove juror ${j.model}` },
          onclick: () => { payload.jurors.splice(i, 1); touch(); redraw(); },
        }, "remove") : null,
      ));
    });
    if (!ro) {
      const addPicker = modelpicker.render({
        catalog,
        structuredFilter: true,
        showSelected: false,
        label: "Add juror from catalog",
        placeholder: "add juror — search the catalog…",
        onPick: ({ provider, entry }) => {
          payload.jurors.push({
            provider, model: entry.id, snapshot: entry.snapshot ?? null, family: entry.family,
            params: { temperature: 0, maxTokens: 400 }, workerClass: entry.class ?? "small",
          });
          touch(); redraw();
        },
      });
      jurorWrap.append(el("div", { class: "juror juror--add" }, addPicker.el));
    }
    paintWarnAndCost();
  };

  const paintWarnAndCost = () => {
    clear(warnBox);
    const fams = payload.jurors.map((j) => j.family ?? familyOf(j));
    const dupes = fams.filter((f, i) => fams.indexOf(f) !== i);
    if (dupes.length) {
      warnBox.append(el("p", { class: "annotation annotation--signal" },
        el("span", { class: "chip chip--signal" }, "family overlap"),
        ` Two jurors share the “${dupes[0]}” family — correlated errors defeat the point of a panel. Swap one for a disjoint family.`));
    }
    if (payload.jurors.length > 0 && payload.jurors.length < 3) {
      warnBox.append(el("p", { class: "faint screen__hint" }, "Panels run best at 3–5 jurors from disjoint families."));
    }
    // live cost-per-1k: ~800 in + 120 out tokens per call per juror
    const perUnit = payload.jurors.reduce((sum, j) => {
      const m = allModels.find((x) => x.id === j.model && x.provider === j.provider);
      const inP = m?.pricing?.inUSDper1M ?? 1;
      const outP = m?.pricing?.outUSDper1M ?? 4;
      return sum + (800 / 1e6) * inP + (120 / 1e6) * outP;
    }, 0);
    costLine.textContent = payload.jurors.length
      ? `cost as composed: ${fmtCost(perUnit * 1000)} per 1,000 units (${payload.jurors.length} jurors × ~800 in / 120 out tokens)`
      : "add jurors to see the running cost per 1,000 units";
    const noParamData = payload.jurors.some((j) => {
      const e = modelpicker.findEntry(catalog, j.provider, j.model);
      return !e || !Array.isArray(e.params);
    });
    paramsNote.textContent = noParamData
      ? "Parameter support varies by model; unsupported settings are ignored by the provider."
      : "";
  };

  redraw();
  main.append(section("Panel composition", jurorWrap, warnBox, costLine, paramsNote));

  /* aggregation rule, in plain language */
  const explain = el("p", { class: "screen__hint" }, AGG_RULES[payload.aggregation] ?? "");
  main.append(section("Aggregation",
    el("div", { class: "controlrow" },
      el("select", {
        class: "input input--inline", disabled: ro, "aria-label": "Aggregation rule",
        onchange: (e) => {
          payload.aggregation = e.target.value;
          explain.textContent = AGG_RULES[payload.aggregation] ?? "";
          touch();
        },
      },
        ...Object.keys(AGG_RULES).map((r) =>
          el("option", { value: r, selected: payload.aggregation === r }, r)))),
    explain));
}

function familyOf(j) {
  return j.family ?? String(j.model ?? "").split(/[-:/]/)[0];
}

/* ================= shared cards ===================================================== */

function certificateCard(cert, { reliabilityHref = null } = {}) {
  const a = cert.agreement ?? {};
  return el("div", { class: "certificate" },
    el("p", { class: "certificate__seal", aria: { hidden: "true" } }, "●"),
    kvList(
      kv("Frozen", fmtDateTime(cert.frozenAt)),
      kv("Against gold", el("span", { class: "data" }, cert.goldsetId ?? "—")),
      kv("Agreement", markedValue(`κ = ${fmtStat(a.kappa)} · α = ${fmtStat(a.alpha)} · AC1 = ${fmtStat(a.ac1)}`, "calibrated"),
        cite("gwet2014"),
        a.ci ? el("span", { class: "faint data" }, ` 95% CI [${fmtStat(a.ci.lo)}, ${fmtStat(a.ci.hi)}] · n = ${a.n}`) : null),
      kv("Human–human", cert.humanAgreement
        ? el("span", { class: "data" }, `κ = ${fmtStat(cert.humanAgreement.kappa)} · α = ${fmtStat(cert.humanAgreement.alpha)} (n = ${cert.humanAgreement.n})`)
        : "—"),
      kv("Version", el("span", { class: "data" }, String(cert.versionHash ?? "").slice(0, 16))),
      kv("Model pinned", cert.modelPinned ? "yes — snapshot recorded" : "no — stated plainly in methods"),
      reliabilityHref
        ? kv("All sources", el("a", { href: reliabilityHref }, "the construct's reliability matrix →"))
        : null,
    ),
    a.perClass?.length
      ? el("table", { class: "table table--mini" },
          el("caption", { class: "sr-only" }, "Per-class precision, recall, F1"),
          el("thead", {}, el("tr", {},
            el("th", { scope: "col" }, "class"), el("th", { scope: "col", class: "table__num data" }, "P"),
            el("th", { scope: "col", class: "table__num data" }, "R"), el("th", { scope: "col", class: "table__num data" }, "F1"),
            el("th", { scope: "col", class: "table__num data" }, "n"))),
          el("tbody", {},
            ...a.perClass.map((r) => el("tr", {},
              el("td", {}, r.label),
              el("td", { class: "table__num data" }, fmtStat(r.precision)),
              el("td", { class: "table__num data" }, fmtStat(r.recall)),
              el("td", { class: "table__num data" }, fmtStat(r.f1)),
              el("td", { class: "table__num data" }, String(r.support))))))
      : null,
  );
}

function silverCurve(iterations) {
  const wrap = el("div", { class: "silvercurve" });
  line.render(wrap, [{
    label: "agreement",
    emphasis: true,
    points: iterations.map((it, i) => ({ x: i + 1, y: it.agreement })),
  }], {
    caption: "Silver agreement by tuning iteration — Director labels, superseded by human gold",
    formatX: (x) => `it ${x}`,
    formatY: (v) => fmtStat(v),
    dots: true,
    height: 150,
  });
  wrap.append(el("ol", { class: "iterlist", role: "list" },
    ...iterations.map((it, i) =>
      el("li", { class: "iterlist__row" },
        el("span", { class: "data iterlist__n" }, `it ${i + 1}`),
        el("span", { class: "data iterlist__a" }, `α ${fmtStat(it.agreement)}`),
        el("span", { class: "iterlist__note faint" }, it.note ?? "")))));
  return wrap;
}

/* ================= actions =========================================================== */

function actionRow(main, params, inst, { onPreviewed, previewScope = null, construct = null } = {}) {
  const out = el("div", { class: "actionout" });
  const row = el("div", { class: "actionrow" });

  const compile = el("button", {
    class: "btn", type: "button",
    onclick: async () => {
      const stop = buttonBusy(compile, (sec) => `${glyph.GLYPH} Compiling · ${sec}s`);
      clear(out).append(el("p", { class: "faint", role: "status" }, `${glyph.GLYPH} the Director is writing the prompt from the construct — ~30–60 s`));
      try {
        const next = await api.instruments.compile(params.slug, inst.id);
        stop();
        toast.success(`Compiled v${next.version}.`, { detail: "Director-compiled — review the prompt below and edit to make it yours", data: false });
        await refreshProject(params.slug).catch(() => {});
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      } catch (err) {
        stop();
        clear(out);
        toast.error("Compile failed.", { detail: String(err.message ?? err) });
      }
    },
  }, `${glyph.GLYPH} Compile`);

  const silver = el("button", {
    class: "btn", type: "button",
    onclick: () => {
      const stop = buttonBusy(silver, (sec) => `Silver-tuning · ${sec}s`);
      clear(out).append(el("p", { class: "overline" }, "Silver-tuning — Director labels a sample, the worker iterates"));
      const list = el("ol", { class: "itercards", role: "list", aria: { live: "polite" } });
      out.append(list);
      const pts = [];
      let chart = null;
      api.instruments.silverTune(params.slug, inst.id, { corpusId: previewScope?.corpusId ?? undefined }, {
        onIteration(it) {
          pts.push({ x: pts.length + 1, y: it.agreement });
          const prev = pts.length > 1 ? pts[pts.length - 2].y : null;
          list.append(el("li", { class: "itercard" },
            el("span", { class: "data itercard__n" }, `iteration ${pts.length}`),
            el("span", { class: "data itercard__a" },
              `α ${fmtStat(it.agreement)}`,
              prev !== null ? el("span", { class: `itercard__delta ${it.agreement >= prev ? "" : "itercard__delta--down"}` }, ` ${it.agreement >= prev ? "+" : "−"}${fmtStat(Math.abs(it.agreement - prev))}`) : null),
            el("span", { class: "itercard__note" }, it.note ?? "")));
          if (!chart) {
            const cWrap = el("div", { class: "itercards__chart" });
            out.append(cWrap);
            chart = line.render(cWrap, [{ label: "α", emphasis: true, points: [...pts] }],
              { caption: "agreement curve", formatX: (x) => `it ${x}`, formatY: (v) => fmtStat(v), dots: true, height: 130 });
          } else {
            chart.update([{ label: "α", emphasis: true, points: [...pts] }]);
          }
        },
        onDone(final) {
          // live done payload: {instrumentId, level, versionHash, stability,
          // curve, cost, stoppedBy?}
          stop();
          const last = final?.curve?.at?.(-1)?.agreement ?? pts[pts.length - 1]?.y;
          out.append(el("p", { class: "screen__hint" },
            `Plateaued at α = ${fmtStat(last)} on silver`,
            final?.stability?.alpha !== undefined ? ` · test–retest α = ${fmtStat(final.stability.alpha)}` : "",
            final?.level ? el("span", {}, " — ", ladderC.render({ level: final.level, size: "sm", label: true })) : null,
            " ", el("span", { class: "faint" }, "Human gold supersedes silver.")));
          refreshProject(params.slug).catch(() => {});
        },
        onError(err) {
          stop();
          out.append(el("p", { class: "faint" }, "Tuning stream failed: ", String(err.message ?? err)));
        },
      });
    },
  }, "Silver-tune");

  const stability = el("button", {
    class: "btn", type: "button",
    onclick: async () => {
      const stop = buttonBusy(stability, (sec) => `Checking stability · ${sec}s`);
      clear(out).append(el("p", { class: "faint", role: "status" }, "re-running k = 3 on a 100-unit subsample…"));
      try {
        // live response: {alpha, pass} (k/n persist onto instrument.stability)
        const res = await api.instruments.stability(params.slug, inst.id, { corpusId: previewScope?.corpusId ?? undefined });
        clear(out).append(el("p", { class: "screen__hint" },
          markedValue(`test–retest α = ${fmtStat(res.alpha)}`, res.pass ? "stabilized" : "exploratory"),
          " ",
          res.pass
            ? el("span", {}, "— the instrument gives the same labels when rerun on the same units. ", el("strong", {}, "Marked ◑ stabilized."))
            : el("span", {}, "— below the .80 bar (Krippendorff's reliable threshold", cite("krippendorff2004"), "); the instrument changes its labels when rerun on the same units."),
          " Rerun-vs-rerun rows are now in Reliability for this construct."));
        if (res.pass) toast.success("Stability passed — instrument is ◑.", { detail: `α = ${fmtStat(res.alpha)}`, data: true });
        await refreshProject(params.slug).catch(() => {});
      } catch (err) {
        toast.error("Stability check failed.", { detail: String(err.message ?? err) });
      }
      stop();
    },
  }, "Stability check");

  const preview = el("button", {
    class: "btn", type: "button",
    onclick: async () => {
      const stop = buttonBusy(preview, (sec) => `Previewing · ${sec}s`);
      clear(out).append(el("p", { class: "faint", role: "status" }, "previewing on 5 sample units (nothing persists)…"));
      try {
        const corpus = previewScope?.corpus() ?? null;
        const units = await sampleUnits(params.slug, corpus, 5);
        if (units.length === 0) throw new Error(corpus ? `no units to preview on in ${scopechip.displayName(corpus)}` : "no corpus units to preview on");
        // live envelope: {outputs, cost, quarantine, missing} — quarantine
        // entries are {unitId, code, message} (older servers: bare unit ids)
        const res = await api.instruments.preview(params.slug, inst.id, { unitIds: units.map((u) => u.id), corpusId: corpus?.id ?? undefined });
        const outputs = (res?.outputs ?? []).filter((o) => o.label !== undefined);
        // failures first — when every unit failed, the panel IS the result.
        // frag() skips null children; NATIVE append would print them as "null".
        const failed = failurePanel(res?.quarantine, units.length);
        clear(out).append(frag(
          readLine(corpus, units.length),
          failed,
          outputs.length
            ? el("table", { class: "table table--mini" },
                el("caption", { class: "sr-only" }, "Preview outputs"),
                el("thead", {}, el("tr", {},
                  el("th", { scope: "col" }, "unit"), el("th", { scope: "col" }, "label"),
                  el("th", { scope: "col", class: "table__num data" }, "conf"), el("th", { scope: "col" }, "rationale"))),
                el("tbody", {},
                  ...outputs.map((o) => el("tr", {},
                    el("td", {}, el("button", { class: "refchip data evidence-door", type: "button", dataset: { evidence: o.unitId } }, String(o.unitId).slice(0, 8) + "…")),
                    el("td", {}, el("span", { class: "chip chip--machine" }, String(o.label))),
                    el("td", { class: "table__num data" }, o.confidence !== undefined ? fmtStat(o.confidence) : "—"),
                    el("td", { class: "previewrationale" }, o.rationale ?? "—")))))
            : failed ? null : el("p", { class: "faint" }, "No outputs came back for these units — and none were quarantined; the server may not know these unit ids.")));
        onPreviewed?.();
      } catch (err) {
        clear(out).append(el("p", { class: "faint" }, "Preview failed: ", String(err.message ?? err)));
      }
      stop();
    },
  }, "Preview on 5 units");

  const freeze = el("button", {
    class: "btn", type: "button", disabled: inst.frozen,
    onclick: () => freezeSheet(params, inst, previewScope, construct),
  }, inst.frozen ? "Frozen ●" : "Freeze → ●");

  const runOther = el("a", {
    class: "btn",
    href: `#/p/${params.slug}/runs?preflight=${encodeURIComponent(inst.id)}`,
    title: "Open the run preflight with this instrument preselected — pick any corpus there.",
  }, "Run on another corpus…");

  // Which corpus these actions read lives in the scope bar at the TOP of the
  // editor (scopeBar); the readLine on every preview result still names it.
  row.append(compile, silver, stability, preview, freeze, runOther);
  return {
    el: el("div", {}, row, out),
    clickPreview: () => {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      if (!preview.disabled) preview.click();
    },
  };
}

function freezeSheet(params, inst, previewScope = null, construct = null) {
  const s = openSheet({ title: "Freeze this instrument", overline: "Calibration certificate" });
  let goldsetId = null;
  let select = null;
  // "Gold — <construct>" names; legacy sets derive the same shape
  const goldName = (g) => g.name ?? (construct ? `Gold — ${construct.name}` : g.id);

  // create-and-go: a new gold set for THIS construct, sampling from the
  // editor's current scope corpus, landing in the studio's Sample pane
  const createGoldBtn = (label, cls) => el("button", {
    class: cls, type: "button",
    onclick: async (e) => {
      e.target.disabled = true;
      try {
        const created = await api.goldsets.create(params.slug, {
          constructId: inst.constructId,
          corpusId: previewScope?.corpusId ?? undefined,
        });
        toast.success("Gold set created.", { detail: "draw the sample, then code it blind", data: false });
        await refreshProject(params.slug).catch(() => {});
        s.close();
        router.navigate(`p/${params.slug}/goldsets/${created.id}`);
      } catch (err) {
        e.target.disabled = false;
        toast.error("Could not create the gold set.", { detail: String(err.message ?? err) });
      }
    },
  }, label);

  const pickerHost = el("div", {});
  s.body.append(
    el("p", {}, "Freezing stamps the version hash into a calibration certificate with its agreement-vs-gold numbers. The instrument becomes read-only; any future edit forks a new ◌ version."),
    pickerHost,
  );

  api.goldsets.list(params.slug).then((sets) => {
    const own = (sets ?? []).filter((g) => g.constructId === inst.constructId);
    if (!own.length) {
      freezeBtn.disabled = true;
      pickerHost.append(
        el("p", { class: "screen__hint" },
          "Freezing needs a human gold standard: a sample you code by hand, so agreement statistics can certify the instrument."),
        el("p", {}, createGoldBtn("Create a gold set for this construct", "btn btn--primary")),
      );
      return;
    }
    select = el("select", { class: "input", "aria-label": "Gold set" },
      el("option", { value: "" }, "choose a gold set…"),
      ...own.map((g) => el("option", { value: g.id }, `${goldName(g)} (${g.status})`)));
    select.addEventListener("change", () => { goldsetId = select.value || null; });
    pickerHost.append(
      el("label", { class: "field" }, el("span", { class: "field__label overline" }, "Certify against"), select),
      el("p", { class: "screen__hint faint" }, createGoldBtn("or create another…", "btn btn--quiet")),
    );
  }).catch(() => {
    pickerHost.append(el("p", { class: "faint" }, "Gold sets unavailable — try again."));
  });

  const freezeBtn = el("button", {
    class: "btn btn--primary", type: "button",
    onclick: async () => {
      if (!goldsetId) { select?.focus(); return; }
      const stop = sheetBusy(s, freezeBtn, {
        label: (sec) => `Calibrating against gold · ${sec}s`,
        hint: "judging the gold units with this instrument — one pass, then the certificate",
      });
      try {
        const cert = await api.instruments.freeze(params.slug, inst.id, { goldsetId });
        stop();
        s.close();
        toast.success("Instrument frozen at ●.", { detail: `κ = ${fmtStat(cert?.agreement?.kappa)} vs gold · certificate written`, data: true });
        await refreshProject(params.slug).catch(() => {});
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      } catch (err) {
        stop();
        paintFoot();
        toast.error("Freeze failed.", { detail: String(err.message ?? err) });
      }
    },
  }, "Freeze");
  const paintFoot = () => s.foot.replaceChildren(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    freezeBtn,
  );
  paintFoot();
}

/* ================= create / compile — the construct → instrument handoff ============ */

const KIND_LINES = {
  judge: "A model given your codebook as instructions — the Director compiles the prompt from the construct.",
  dictionary: "A transparent term list — instant, free, fully auditable. You edit the terms; no model involved.",
  panel: "Several judges from disjoint model families that vote — catches any one model's blind spots.",
};

/**
 * One sheet from construct to working instrument. Judge (advised): the
 * Director compiles immediately, model defaulted to the project Director's
 * provider/model; dictionary/panel: created empty and opened in the editor.
 */
function compileSheet(params, { project, constructs, catalog, presetConstructId = null } = {}) {
  if (!constructs?.length) {
    toast.info("Write a construct first.", { detail: "instruments compile from the codebook — opening Constructs" });
    router.navigate(`p/${params.slug}/constructs`);
    return;
  }

  let inFlight = false;
  const s = openSheet({
    title: "New instrument", overline: "Construct → instrument",
    onClose: () => {
      if (inFlight) {
        toast.info("Hidden — the compile keeps running.", {
          detail: "the new instrument opens the moment the Director answers",
        });
      }
    },
  });

  let constructId = (presetConstructId && constructs.some((c) => c.id === presetConstructId))
    ? presetConstructId : constructs[0].id;
  let kind = "judge";

  /* construct picker */
  const constructSelect = el("select", { class: "input", "aria-label": "Construct to measure" },
    ...constructs.map((c) => el("option", { value: c.id, selected: c.id === constructId }, c.name)));
  constructSelect.addEventListener("change", () => { constructId = constructSelect.value; });

  /* model slot — defaults to the project Director's provider/model */
  const providers = Object.keys(catalog ?? {});
  let provider = (project?.director?.provider && catalog?.[project.director.provider]?.length)
    ? project.director.provider : providers[0];
  let model = ((catalog?.[provider] ?? []).find((m) => m.id === project?.director?.model)
    ?? (catalog?.[provider] ?? [])[0])?.id ?? null;
  const picker = modelpicker.render({
    catalog,
    value: { provider, model },
    structuredFilter: true,
    label: "Worker model",
    onPick: (p) => { provider = p.provider; model = p.entry.id; },
  });

  const judgeOnly = el("div", { class: "field" },
    el("span", { class: "field__label overline" }, "Worker model"),
    picker.el,
    el("p", { class: "field__hint" }, "Defaulted to this project's Director model — change it freely; the run preflight quotes the cost either way."));

  const GO_LABELS = { judge: "Compile the judge", dictionary: "Create the dictionary", panel: "Create the panel" };
  const kindList = el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Instrument kind" } },
    ...["judge", "dictionary", "panel"].map((k) =>
      el("label", { class: "choice" },
        el("input", {
          type: "radio", name: "inst-kind", value: k, checked: k === kind,
          onchange: () => {
            kind = k;
            judgeOnly.hidden = k !== "judge";
            goBtn.textContent = GO_LABELS[k];
          },
        }),
        el("span", { class: "choice__text" },
          el("span", { class: "choice__label" },
            k,
            k === "judge" ? el("span", { class: "chip chip--ghost choice__advised" }, "most studies start here") : null),
          el("span", { class: "choice__hint" }, KIND_LINES[k])))));

  s.body.append(
    el("label", { class: "field" }, el("span", { class: "field__label overline" }, "Construct"), constructSelect),
    el("div", { class: "field" }, el("span", { class: "field__label overline" }, "Kind"), kindList),
    judgeOnly,
  );

  const goBtn = el("button", {
    class: "btn btn--primary", type: "button",
    onclick: async () => {
      const construct = constructs.find((c) => c.id === constructId);
      const name = `${construct?.name ?? constructId} · ${kind}`;
      let stop = null;
      try {
        if (kind === "judge") {
          inFlight = true;
          stop = sheetBusy(s, goBtn, {
            label: (sec) => `Compiling the judge · ${sec}s`,
            hint: "one Director call writes the prompt from the construct — ~30–60 s",
          });
          const mdl = (catalog?.[provider] ?? []).find((m) => m.id === model);
          const created = await api.instruments.create(params.slug, {
            constructId, kind: "judge", name,
            payload: {
              provider, model,
              snapshot: mdl?.snapshot ?? null,
              workerClass: mdl?.class ?? "mid",
              params: { temperature: 0, maxTokens: 400 },
              promptTemplate: "",
            },
          });
          const compiled = await api.instruments.compile(params.slug, created.id);
          inFlight = false;
          stop();
          toast.success(`Compiled “${name}” v${compiled.version ?? 2}.`, { detail: "review the prompt — edit it to make it yours", data: false });
          await refreshProject(params.slug).catch(() => {});
          s.close();
          router.navigate(`p/${params.slug}/instruments/${created.id}`);
        } else {
          goBtn.disabled = true;
          const payload = kind === "dictionary"
            ? { categories: [], negation: { enabled: false, window: 3 }, scoring: "percentOfWords" }
            : { jurors: [], aggregation: "majority" };
          const created = await api.instruments.create(params.slug, { constructId, kind, name, payload });
          toast.success(`Created “${name}”.`, {
            detail: kind === "dictionary"
              ? `add terms by hand, or ${glyph.GLYPH} Compile to have the Director seed them`
              : "add 3–5 jurors from disjoint model families",
            data: false,
          });
          await refreshProject(params.slug).catch(() => {});
          s.close();
          router.navigate(`p/${params.slug}/instruments/${created.id}`);
        }
      } catch (err) {
        inFlight = false;
        stop?.();
        paintFoot();
        toast.error("Could not create the instrument.", { detail: String(err.message ?? err) });
      }
    },
  }, GO_LABELS.judge);
  const paintFoot = () => {
    goBtn.disabled = false;
    s.foot.replaceChildren(
      el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
      goBtn);
  };
  paintFoot();
}
