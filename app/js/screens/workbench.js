// Workbench — #/p/:slug/analyses[/:id] — where numbers earn their place in a
// paper. Builder rail (kind → variables → run) beside a result canvas:
// crosstabs with χ²/p/min-expected honesty, grouped bars, THE CORRECTION
// REVEAL (corrected solid ◉ beside naive hatched, Δ annotated, one-line
// explainer), model coefficient tables with null-handling, triangulation
// scatter with a divergence browser, and the subgroup audit table. Every cell
// is an evidence door; every number wears its mark.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as ladderC from "../components/ladder.js";
import * as bar from "../components/charts/bar.js";
import * as scatter from "../components/charts/scatter.js";
import * as table from "../components/table.js";
import * as quotecard from "../components/quotecard.js";
import { store } from "../state.js";
import { fmt, fmtStat, fmtP, fmtCount } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, emptyState, markedValue } from "./_shared.js";

export const route = "p/:slug/analyses";
export const routes = ["p/:slug/analyses", "p/:slug/analyses/:id"];
export const title = "Workbench";

const KINDS = [
  { value: "descriptive", label: "Descriptive", hint: "prevalence, distributions" },
  { value: "crosstab", label: "Crosstab", hint: "construct × metadata, χ² honesty, DSL when gold exists" },
  { value: "model", label: "Model", hint: "OLS / logistic with sandwich SEs" },
  { value: "triangulation", label: "Triangulation", hint: "instrument vs instrument — divergence is where reading starts" },
  { value: "subgroup", label: "Subgroup audit", hint: "does the instrument read every group equally well?" },
];

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    let analysis = null;
    if (params.id) {
      analysis = await api.analyses.get?.(params.slug, params.id)?.catch?.(() => null) ?? null;
      if (!analysis) analysis = (project.analyses ?? []).find((a) => a.id === params.id) ?? null;
    }
    return { project, analysis };
  }, ({ project, analysis }) => {
    mount.append(screenHead({
      overline: "Workbench",
      title: "Ask, compute, and show the correction.",
      lede: "Corrected estimates are solid; what you would have naively believed stays visible, hatched, beside them.",
    }));

    const split = el("div", { class: "split split--workbench" });
    mount.append(split);

    /* -- builder rail -- */
    const rail = el("div", { class: "split__list wb-rail" });
    split.append(rail);
    const canvas = el("div", { class: "split__main wb-canvas" });
    split.append(canvas);

    builderRail(rail, canvas, params, project);

    /* -- existing analyses -- */
    if (project.analyses?.length) {
      rail.append(el("h3", { class: "overline split__group" }, "On the bench"),
        ...project.analyses.map((a) =>
          el("a", {
            class: `listitem${analysis?.id === a.id ? " listitem--active" : ""}`,
            href: `#/p/${params.slug}/analyses/${a.id}`,
          },
            el("span", { class: "listitem__name" }, a.name ?? a.id),
            el("span", { class: "listitem__meta" },
              el("span", { class: "chip" }, a.kind),
              ladderC.render({ level: a.level, size: "sm" })))));
    }

    if (analysis) {
      renderResult(canvas, params, analysis);
    } else if (!params.id) {
      canvas.append(emptyState({
        title: "The bench is clear.",
        body: "Pick a kind on the left, choose variables, and run. Results land here with their evidence marks and their doors.",
        hint: "Where a gold sample with π exists, estimates arrive corrected (◉) with the naive number beside them.",
      }));
    } else {
      canvas.append(emptyState({ title: "Analysis not found.", body: "It may not have been computed yet." }));
    }
  }, "Opening the workbench…");
}

/* ================= builder ============================================================== */

function builderRail(rail, canvas, params, project) {
  let kind = "crosstab";
  const constructs = project.constructs ?? [];
  const metaKeys = ["dept", "region", "satisfaction", "tenure_years", "exit_date"];
  const instruments = project.instruments ?? [];

  const constructSel = el("select", { class: "input", "aria-label": "Construct" },
    ...constructs.map((c) => el("option", { value: c.id }, c.name)));
  const metaSel = el("select", { class: "input", "aria-label": "Metadata variable" },
    ...metaKeys.map((k) => el("option", { value: k }, k)));
  const instASel = el("select", { class: "input", "aria-label": "Instrument A" },
    ...instruments.map((i) => el("option", { value: i.id }, i.name)));
  const instBSel = el("select", { class: "input", "aria-label": "Instrument B" },
    ...instruments.map((i, idx) => el("option", { value: i.id, selected: idx === 1 }, i.name)));

  const variableHost = el("div", { class: "wb-vars" });
  const paintVars = () => {
    clear(variableHost);
    if (kind === "triangulation") {
      variableHost.append(
        varField("instrument A (x)", instASel),
        varField("instrument B (y)", instBSel));
    } else if (kind === "subgroup") {
      variableHost.append(
        varField("instrument", instASel),
        varField("split by", metaSel));
    } else if (kind === "descriptive") {
      variableHost.append(varField("construct", constructSel));
    } else {
      variableHost.append(
        varField("construct", constructSel),
        varField(kind === "model" ? "predictors from" : "by", metaSel));
    }
  };

  const kindList = el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Analysis kind" } },
    ...KINDS.map((k) =>
      el("label", { class: "choice" },
        el("input", {
          type: "radio", name: "wbkind", value: k.value, checked: kind === k.value,
          onchange: () => { kind = k.value; paintVars(); },
        }),
        el("span", { class: "choice__text" },
          el("span", { class: "choice__label" }, k.label),
          el("span", { class: "choice__hint" }, k.hint)))));

  const runBtn = el("button", {
    class: "btn btn--primary wb-run", type: "button",
    onclick: async () => {
      runBtn.disabled = true;
      clear(canvas).append(el("p", { class: "faint", role: "status" }, "computing — DSL applies automatically where gold with π exists…"));
      try {
        const spec = kind === "triangulation"
          ? { x: instASel.value, y: instBSel.value }
          : kind === "subgroup"
            ? { instrumentId: instASel.value, by: metaSel.value }
            : { construct: constructSel.value, by: metaSel.value };
        const analysis = await api.analyses.create(params.slug, { kind, spec });
        clear(canvas);
        renderResult(canvas, params, analysis);
        toast.success("Analysis computed.", { detail: `${kind} · ${analysis.level}`, data: true });
      } catch (err) {
        clear(canvas).append(emptyState({ title: "The analysis failed.", body: String(err.message ?? err) }));
      }
      runBtn.disabled = false;
    },
  }, "Run analysis");

  paintVars();
  rail.append(
    el("h3", { class: "overline split__group" }, "Build"),
    kindList,
    variableHost,
    runBtn,
  );

  function varField(label, control) {
    return el("label", { class: "field" },
      el("span", { class: "field__label overline" }, label),
      control);
  }
}

/* ================= results ============================================================== */

function renderResult(canvas, params, analysis) {
  const level = analysis.level ?? "exploratory";
  const results = analysis.results ?? {};

  canvas.append(el("header", { class: "wb-resulthead" },
    el("h3", { class: "wb-resulttitle" },
      analysis.name ?? `${analysis.kind} analysis`,
      " ", ladderC.render({ level, size: "md", label: true })),
    el("button", {
      class: "btn btn--quiet", type: "button",
      onclick: () => addToReport(params, analysis),
    }, "Add to report →")));

  if (analysis.kind === "crosstab") crosstabResult(canvas, analysis);
  else if (analysis.kind === "model") modelResult(canvas, analysis);
  else if (analysis.kind === "triangulation") triangulationResult(canvas, params, analysis);
  else if (analysis.kind === "subgroup") subgroupResult(canvas, analysis);
  else descriptiveResult(canvas, analysis);
}

/* -- descriptive -- */
function descriptiveResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const prevalence = r.prevalence ?? [];
  if (!prevalence.length) {
    canvas.append(emptyState({ title: "Nothing to describe.", body: "Run an instrument first." }));
    return;
  }
  const cell = el("div", {});
  bar.render(cell, prevalence.map((p) => ({
    label: p.label, value: p.value, level: analysis.level, evidence: p.evidence?.length ? p.evidence : undefined,
  })), { caption: "Prevalence — every bar opens its units", format: (v) => fmtStat(v), level: analysis.level });
  canvas.append(section("Prevalence", cell));
}

/* -- crosstab + the Correction Reveal -- */
function crosstabResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const rows = r.rows ?? [];
  const level = analysis.level ?? "exploratory";
  const corrected = level === "corrected" && rows.some((x) => x.corrected);

  /* table with evidence doors */
  canvas.append(section("Crosstab",
    table.render({
      caption: analysis.name ?? "Crosstab",
      columns: [
        { key: "label", label: r.byLabel ?? "group" },
        ...(corrected
          ? [
              { key: "corrected", label: "corrected ◉", numeric: true, format: (v) => fmtStat(v?.value), level: () => "corrected", evidence: (row) => row.evidence?.length ? row.evidence : null },
              { key: "corrected", label: "95% CI", numeric: true, sortable: false, format: (v) => v?.ci ? `[${fmtStat(v.ci[0])}, ${fmtStat(v.ci[1])}]` : "—" },
              { key: "naive", label: "naive", numeric: true, format: (v) => fmtStat(v?.value) },
            ]
          : [
              { key: "value", label: "share", numeric: true, format: (v) => fmtStat(v), level: () => level, evidence: (row) => row.evidence?.length ? row.evidence : null },
            ]),
        { key: "n", label: "n", numeric: true, format: (v) => fmtCount(v) },
      ],
      rows,
      empty: { title: "No cells.", hint: "Pick variables and run." },
    }),
    el("p", { class: "wb-chistats data" },
      `χ² = ${fmt(r.chi2, 1)} · df = ${r.df ?? "—"} · ${fmtP(r.p)} · min expected = ${fmt(r.minExpected, 1)}`,
      (r.minExpected ?? 99) < 5
        ? el("span", { class: "chip chip--signal", title: "Chi-square is unreliable when expected cell counts fall below 5" }, "small-n warning")
        : null)));

  /* the Correction Reveal */
  if (corrected) {
    const reveal = el("div", {});
    bar.render(reveal, rows.map((x) => ({
      label: x.label,
      corrected: x.corrected,
      naive: x.naive,
      evidence: x.evidence?.length ? x.evidence : undefined,
    })), {
      paired: true,
      caption: "The Correction Reveal — corrected ◉ solid with 95% CI; the naive plug-in hatched beside it; Δ annotated per row.",
      format: (v) => fmtStat(v),
    });
    canvas.append(section("Correction Reveal",
      reveal,
      el("p", { class: "wb-explainer" },
        el("span", { class: "chip chip--ghost" }, "◉"),
        " ", r.explainer ?? "Corrected for machine-labeling error using the gold sample (DSL). Machine accuracy buys precision, never validity.")));
  } else {
    canvas.append(el("p", { class: "annotation annotation--still" },
      "These cells are ", el("strong", {}, "uncorrected"), " (", ladderC.mark(level), " ", level, "). A gold sample with stored π would let DSL remove machine-error bias — the watermark travels into every export until then."));
  }
}

/* -- model -- */
function modelResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const coef = r.coef ?? [];
  canvas.append(section("Model",
    el("p", { class: "screen__hint" }, r.model ?? "Model", r.nUnits ? el("span", { class: "data faint" }, ` · n = ${fmtCount(r.nUnits)} units, gold = ${fmtCount(r.nGold)}`) : null),
    table.render({
      caption: analysis.name ?? "Coefficients",
      columns: [
        { key: "name", label: "term" },
        { key: "est", label: "est", numeric: true, format: (v) => fmt(v, 2), level: () => analysis.level },
        { key: "se", label: "se", numeric: true, format: (v) => fmt(v, 2) },
        { key: "z", label: "z", numeric: true, format: (v, row) => (v === null || v === undefined ? "—" : fmt(v, 2)) },
        { key: "p", label: "p", numeric: true, format: (v, row) => (v === null || v === undefined ? (row.note ? "—" : "—") : fmtP(v)) },
      ],
      rows: coef,
      empty: { title: "No coefficients." },
    }),
    ...coef.filter((c) => c.note).map((c) =>
      el("p", { class: "annotation annotation--still" },
        el("span", { class: "chip chip--ghost" }, c.name), " ", c.note)),
    r.explainer ? el("p", { class: "wb-explainer faint" }, r.explainer) : null,
    r.naive?.length
      ? el("details", { class: "rawreveal" },
          el("summary", { class: "rawreveal__summary" }, "naive (uncorrected) coefficients"),
          table.render({
            caption: "Naive coefficients",
            columns: [
              { key: "name", label: "term" },
              { key: "est", label: "est", numeric: true, format: (v) => fmt(v, 2) },
              { key: "se", label: "se", numeric: true, format: (v) => fmt(v, 2) },
            ],
            rows: r.naive,
          }))
      : null));
}

/* -- triangulation -- */
function triangulationResult(canvas, params, analysis) {
  const r = analysis.results ?? {};
  const cell = el("div", {});
  scatter.render(cell, (r.points ?? []).map((p) => ({ x: p.x, y: p.y, label: p.label, id: p.id ?? undefined })), {
    caption: `Per-sub-theme scores — identity is agreement; strays past |Δ| > ${r.threshold ?? 0.2} speak signal. r = ${fmtStat(r.pearson)}`,
    xLabel: r.xLabel ?? "instrument A",
    yLabel: r.yLabel ?? "instrument B",
    threshold: r.threshold ?? 0.2,
    format: (v) => fmtStat(v),
  });
  canvas.append(section("Triangulation", cell));

  const divergent = r.divergent ?? [];
  const browser = el("div", { class: "divbrowser" });
  if (!divergent.length) {
    browser.append(el("p", { class: "faint" }, "No divergent clusters — the instruments read alike here."));
  }
  for (const d of divergent) {
    const row = el("div", { class: "divrow" },
      el("div", { class: "divrow__head" },
        el("span", { class: "chip chip--signal data" }, `Δ ${fmtStat(Math.abs(d.x - d.y))}`),
        el("span", { class: "divrow__label" }, d.label),
        el("span", { class: "faint data" }, `${r.xLabel ?? "A"} ${fmtStat(d.x)} · ${r.yLabel ?? "B"} ${fmtStat(d.y)}`)),
      el("p", { class: "divrow__note" }, d.note ?? ""));
    if (d.id) {
      const quoteHost = el("div", {});
      row.append(quoteHost);
      api.evidence.get(params.slug, d.id)
        .then((dossier) => quoteHost.append(quotecard.render({ unit: dossier.unit, lang: dossier.lang, compact: true, evidence: true })))
        .catch(() => {});
    }
    browser.append(row);
  }
  canvas.append(section("Divergence browser — where reading starts", browser));
}

/* -- subgroup audit -- */
function subgroupResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const rows = r.rows ?? [];
  canvas.append(section("Subgroup audit",
    el("p", { class: "screen__hint" }, r.note ?? "Agreement with gold, split by metadata group.",
      r.pooledKappa !== undefined ? el("span", { class: "data" }, ` Pooled κ = ${fmtStat(r.pooledKappa)}.`) : null),
    table.render({
      caption: analysis.name ?? "Subgroup audit",
      columns: [
        { key: "group", label: "group", format: (v, row) => row.flagged ? el("span", { class: "subgroupflag" }, el("span", { class: "chip chip--signal" }, "flag"), " ", v) : v },
        { key: "n", label: "n", numeric: true, format: (v) => fmtCount(v) },
        { key: "kappa", label: "κ", numeric: true, format: (v) => fmtStat(v), level: () => analysis.level, evidence: (row) => row.evidence?.length ? row.evidence : null },
        { key: "percent", label: "% agree", numeric: true, format: (v) => fmtStat(v) },
        { key: "note", label: "", sortable: false, format: (v) => v ?? "" },
      ],
      rows,
      sort: { key: "kappa", dir: "asc" },
      empty: { title: "No groups to audit." },
    })));
}

/* ================= export to report ====================================================== */

function addToReport(params, analysis) {
  const blocks = store.get("report.blocks") ?? [];
  blocks.push({
    id: `blk_${Date.now().toString(36)}`,
    type: analysis.kind === "model" ? "table" : "chart",
    source: "analysis",
    analysisId: analysis.id,
    title: analysis.name ?? analysis.kind,
    level: analysis.level,
  });
  store.set("report.blocks", blocks);
  toast.success("Added to the report canvas.", {
    detail: `${analysis.name ?? analysis.kind} — arrange it under Reports`,
  });
}
