// Workbench — #/p/:slug/analyses[/:id] — where numbers earn their place in a
// paper. Builder rail (kind → variables → run) beside a result canvas:
// crosstabs with χ²/p/min-expected honesty, THE CORRECTION REVEAL (corrected
// solid ◉ beside naive hatched, Δ annotated, one-line explainer), model
// coefficient tables, triangulation with a divergence browser, and the
// subgroup table. Every cell is an evidence door; every number wears its mark.
//
// Live contract (POST /api/projects/:p/analyses {kind, spec}) → analysis
// {id, kind, spec, results, level, evidence: {cells}, createdAt}. Results by
// kind:
//   descriptive   {n, distribution: {label: {n, share}}, estimator?, cells?}
//                 (+ prevalence/crosstabs/cooccurrence/calibrationNudge when
//                 spec.runId rode the request — the Explorer surface)
//   crosstab      {table: {rows, cols, matrix, rowTotals, colTotals, total,
//                 expected, minExpected, chi2, df, p}, warnings: [{kind,
//                 message}], estimator?, outcome?, groupBy?, positive?,
//                 cells?: [{group, n, est, se, ciLo, ciHi, naive}], diff?}
//   model         {family, outcome, estimator?, coef: [{name, est, se}],
//                 naive?: [{name, est, se}], n, nGold?}
//   triangulation {instruments: [{instrumentId, name, kind, level, runId}],
//                 n, percentAgreement, kappa, divergent: [{unitId, a, b}],
//                 pairs: [{unitId, a, b}]}
//   subgroup      the reliability audit (requires complete gold; 400 sans):
//                 {by, positive, overall {goldN, percentAgreement, kappa,
//                 errorRate}, groups: [{group, n, dist, goldN,
//                 percentAgreement, kappa, errorRate, flagged, note?,
//                 corrected?}], estimator?, cells?} — flagged groups sit
//                 >0.1 below the overall agreement
// Spec shapes the routes accept: crosstab {rowKey, colKey}; model {x: [metaKey],
// family}; triangulation {instrumentIds: [a, b]}; subgroup {instrumentId, by};
// every run-backed kind takes runId/instrumentId/corpusId hints for pickRun.
// GET analyses/:id serves the persisted artifact, so deep links re-render the
// computed numbers; 404 (artifact gone) falls back to the project summary
// {id, kind, level, createdAt} and the recompute state.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as toast from "../components/toast.js";
import * as ladderC from "../components/ladder.js";
import * as bar from "../components/charts/bar.js";
import * as scatter from "../components/charts/scatter.js";
import * as table from "../components/table.js";
import * as quotecard from "../components/quotecard.js";
import { store } from "../state.js";
import { fmt, fmtStat, fmtP, fmtCount } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, emptyState } from "./_shared.js";

export const route = "p/:slug/analyses";
export const routes = ["p/:slug/analyses", "p/:slug/analyses/:id"];
export const title = "Workbench";

const KINDS = [
  { value: "descriptive", label: "Descriptive", hint: "prevalence, distributions" },
  { value: "crosstab", label: "Crosstab", hint: "construct × metadata, χ² honesty, DSL when gold exists" },
  { value: "model", label: "Model", hint: "OLS / logistic with sandwich SEs" },
  { value: "triangulation", label: "Triangulation", hint: "instrument vs instrument — divergence is where reading starts" },
  { value: "subgroup", label: "Subgroup audit", hint: "machine-vs-gold agreement and error rates by group — needs a complete gold set" },
];

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    let analysis = null;
    if (params.id) {
      // the persisted artifact (GET analyses/:id); a 404 — artifact missing
      // on disk — falls back to the project's summary entry and the honest
      // recompute state below
      analysis = await api.analyses.get(params.slug, params.id).catch(() => null);
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

    /* -- existing analyses (project summaries: {id, kind, level, createdAt}) -- */
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

    if (analysis?.results) {
      renderResult(canvas, params, analysis);
    } else if (analysis) {
      canvas.append(emptyState({
        title: `${analysis.kind} analysis · ${analysis.id}`,
        body: "Its computed artifact is no longer on disk — recompute it from the builder to read the numbers (cached calls keep it cheap).",
        hint: `level: ${analysis.level}`,
      }));
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
  const instruments = project.instruments ?? [];
  // metadata keys come from the corpus's detected columns when the project
  // carries them; otherwise offer the common demo keys
  const metaKeys = ["dept", "region", "satisfaction", "tenure_years", "role_level"];

  const constructSel = el("select", { class: "input", "aria-label": "Construct" },
    ...constructs.map((c) => el("option", { value: c.id }, c.name)));
  const metaSel = el("select", { class: "input", "aria-label": "Metadata variable" },
    ...metaKeys.map((k) => el("option", { value: k }, k)));
  const instASel = el("select", { class: "input", "aria-label": "Instrument A" },
    ...instruments.map((i) => el("option", { value: i.id }, i.name)));
  const instBSel = el("select", { class: "input", "aria-label": "Instrument B" },
    ...instruments.map((i, idx) => el("option", { value: i.id, selected: idx === 1 }, i.name)));

  const instrumentForConstruct = () =>
    instruments.find((i) => i.constructId === constructSel.value)?.id;

  const variableHost = el("div", { class: "wb-vars" });
  const paintVars = () => {
    clear(variableHost);
    if (kind === "triangulation") {
      variableHost.append(
        varField("instrument A", instASel),
        varField("instrument B", instBSel));
    } else if (kind === "subgroup") {
      variableHost.append(
        varField("instrument", instASel),
        varField("split by", metaSel));
    } else if (kind === "descriptive") {
      variableHost.append(varField("construct", constructSel));
    } else {
      variableHost.append(
        varField("construct", constructSel),
        varField(kind === "model" ? "predictor (numeric meta)" : "by", metaSel));
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

  // live spec shapes per kind (see header contract)
  const specFor = () => {
    if (kind === "triangulation") return { instrumentIds: [instASel.value, instBSel.value] };
    if (kind === "subgroup") return { instrumentId: instASel.value, by: metaSel.value };
    const instrumentId = instrumentForConstruct();
    if (kind === "model") return { x: [metaSel.value], family: "logit", ...(instrumentId ? { instrumentId } : {}) };
    if (kind === "crosstab") return { rowKey: "label", colKey: metaSel.value, ...(instrumentId ? { instrumentId } : {}) };
    return instrumentId ? { instrumentId } : {};
  };

  const runBtn = el("button", {
    class: "btn btn--primary wb-run", type: "button",
    onclick: async () => {
      runBtn.disabled = true;
      clear(canvas).append(el("p", { class: "faint", role: "status" }, "computing — DSL applies automatically where gold with π exists…"));
      try {
        const analysis = await api.analyses.create(params.slug, { kind, spec: specFor() });
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

  canvas.append(el("header", { class: "wb-resulthead" },
    el("h3", { class: "wb-resulttitle" },
      `${analysis.kind} analysis`,
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

const cellsOf = (analysis) => analysis.evidence?.cells ?? {};
const doorIds = (analysis, key) => {
  const ids = cellsOf(analysis)[key];
  return ids?.length ? ids : null;
};

/* -- descriptive: {n, distribution: {label: {n, share}}} -- */
function descriptiveResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const entries = Object.entries(r.distribution ?? {});
  if (!entries.length) {
    canvas.append(emptyState({ title: "Nothing to describe.", body: "Run an instrument first." }));
    return;
  }
  const cell = el("div", {});
  bar.render(cell, entries.map(([label, d]) => ({
    label,
    value: d.share,
    level: analysis.level,
    evidence: doorIds(analysis, label) ?? undefined,
  })), {
    caption: `Label distribution over ${fmtCount(r.n)} units — every bar opens its units`,
    format: (v) => fmtStat(v),
    level: analysis.level,
    domain: [0, 1],
  });
  canvas.append(section("Distribution", cell));
  correctedCellsBlock(canvas, analysis); // descriptive can carry corrected cells too
}

/* -- crosstab: contingency table + χ² honesty + the Correction Reveal -- */
function crosstabResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const t = r.table ?? {};
  const level = analysis.level ?? "exploratory";
  const { rowKey, colKey } = analysis.spec ?? {};

  if (Array.isArray(t.rows) && Array.isArray(t.cols) && Array.isArray(t.matrix)) {
    canvas.append(section("Crosstab",
      el("div", { class: "tablewrap" },
        el("table", { class: "table" },
          el("caption", { class: "sr-only" }, `${rowKey ?? "row"} × ${colKey ?? "col"} contingency table`),
          el("thead", {}, el("tr", {},
            el("th", { scope: "col" }, `${rowKey ?? ""} \\ ${colKey ?? ""}`),
            ...t.cols.map((c) => el("th", { scope: "col", class: "table__num data" }, String(c))),
            el("th", { scope: "col", class: "table__num data" }, "Σ"))),
          el("tbody", {},
            ...t.rows.map((row, i) => el("tr", {},
              el("th", { scope: "row" }, String(row)),
              ...t.cols.map((col, j) => {
                const ids = doorIds(analysis, `${row}|${col}`);
                const text = fmtCount(t.matrix[i][j]);
                return el("td", { class: "table__num data" },
                  ids
                    ? el("button", { class: "evidence-door table__doorbtn", type: "button", dataset: { evidence: ids.join(",") } }, text)
                    : text);
              }),
              el("td", { class: "table__num data" }, fmtCount(t.rowTotals?.[i])))),
            el("tr", {},
              el("th", { scope: "row" }, "Σ"),
              ...t.cols.map((_, j) => el("td", { class: "table__num data" }, fmtCount(t.colTotals?.[j]))),
              el("td", { class: "table__num data" }, fmtCount(t.total)))))),
      el("p", { class: "wb-chistats data" },
        `χ² = ${fmt(t.chi2, 1)} · df = ${t.df ?? "—"} · ${fmtP(t.p)} · min expected = ${fmt(t.minExpected, 1)}`,
        (t.minExpected ?? 99) < 5
          ? el("span", { class: "chip chip--signal", title: "Chi-square is unreliable when expected cell counts fall below 5" }, "small-n warning")
          : null),
      ...(r.warnings ?? []).map((w) =>
        el("p", { class: "annotation annotation--still" },
          el("span", { class: "chip chip--signal" }, w.kind ?? "note"), " ", w.message ?? String(w)))));
  }

  correctedCellsBlock(canvas, analysis);

  if (!(level === "corrected" && r.cells?.length)) {
    canvas.append(el("p", { class: "annotation annotation--still" },
      "These cells are ", el("strong", {}, "uncorrected"), " (", ladderC.mark(level), " ", level, "). A gold sample with stored π would let DSL remove machine-error bias — the watermark travels into every export until then."));
  }
}

/* The canonical corrected shape shared by descriptive/crosstab/subgroup:
   results.{estimator, outcome, groupBy, positive?, cells: [{group, n, est,
   se, ciLo, ciHi, naive: {est, se, ciLo, ciHi}}], diff?}. */
function correctedCellsBlock(canvas, analysis) {
  const r = analysis.results ?? {};
  if (!r.cells?.length || !r.estimator) return;
  const positive = r.positive ?? null;

  const reveal = el("div", {});
  bar.render(reveal, r.cells.map((c) => ({
    label: c.group ?? "(all)",
    corrected: { value: c.est, ci: [c.ciLo, c.ciHi] },
    naive: { value: c.naive?.est },
    evidence: positive ? doorIds(analysis, `${positive}|${c.group}`) ?? undefined : doorIds(analysis, String(c.group)) ?? undefined,
  })), {
    paired: true,
    caption: `The Correction Reveal — corrected ◉ solid with 95% CI; the naive plug-in hatched beside it; Δ annotated per row. Estimator: ${r.estimator}.`,
    format: (v) => fmtStat(v),
  });

  canvas.append(section("Correction Reveal",
    table.render({
      caption: `Corrected ${r.outcome ?? "estimate"}${r.groupBy ? ` by ${r.groupBy}` : ""}`,
      columns: [
        { key: "group", label: r.groupBy ?? "group" },
        { key: "est", label: "corrected ◉", numeric: true, format: (v) => fmtStat(v), level: () => "corrected", evidence: (row) => (positive ? doorIds(analysis, `${positive}|${row.group}`) : doorIds(analysis, String(row.group))) },
        { key: "ciLo", label: "95% CI", numeric: true, sortable: false, format: (v, row) => `[${fmtStat(row.ciLo)}, ${fmtStat(row.ciHi)}]` },
        { key: "naive", label: "naive", numeric: true, format: (v) => fmtStat(v?.est) },
        { key: "n", label: "n", numeric: true, format: (v) => fmtCount(v) },
      ],
      rows: r.cells,
      empty: { title: "No corrected cells." },
    }),
    reveal,
    r.diff
      ? el("p", { class: "data wb-chistats" },
          `Δ(${r.diff.a} − ${r.diff.b}) = ${fmtStat(r.diff.est)} · 95% CI [${fmtStat(r.diff.ciLo)}, ${fmtStat(r.diff.ciHi)}]`)
      : null,
    el("p", { class: "wb-explainer" },
      el("span", { class: "chip chip--ghost" }, "◉"),
      " Corrected for machine-labeling error using the gold sample (DSL). Machine accuracy buys precision, never validity."),
    ...(r.skippedGroups ?? []).map((s) =>
      el("p", { class: "annotation annotation--still faint" },
        el("span", { class: "chip chip--ghost" }, s.group), " ", s.reason))));
}

/* -- model: {family, outcome, estimator?, coef, naive?, n, nGold?} — DSL
   fits' coefficient rows carry {name, est, se, z, p, note?} (z/p null with
   an explanatory note when se = 0); plain fits carry {name, est, se}. -- */
function modelResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const coef = r.coef ?? [];
  const zp = (v) => (v === null || v === undefined ? "—" : fmt(v, 2));
  canvas.append(section("Model",
    el("p", { class: "screen__hint" },
      r.estimator ?? r.family ?? "Model",
      r.outcome ? el("span", { class: "faint" }, ` · outcome: ${r.outcome}`) : null,
      r.n ? el("span", { class: "data faint" }, ` · n = ${fmtCount(r.n)}${r.nGold !== undefined ? `, gold = ${fmtCount(r.nGold)}` : ""}`) : null,
      r.converged === false ? el("span", { class: "chip chip--signal" }, "did not converge") : null),
    table.render({
      caption: "Coefficients",
      columns: [
        { key: "name", label: "term" },
        { key: "est", label: "est", numeric: true, format: (v) => fmt(v, 3), level: () => analysis.level },
        { key: "se", label: "se", numeric: true, format: (v) => fmt(v, 3) },
        { key: "z", label: "z", numeric: true, format: zp },
        { key: "p", label: "p", numeric: true, format: (v) => (v === null || v === undefined ? "—" : fmtP(v)) },
      ],
      rows: coef,
      empty: { title: "No coefficients." },
    }),
    ...coef.filter((c) => c.note).map((c) =>
      el("p", { class: "annotation annotation--still" },
        el("span", { class: "chip chip--ghost" }, c.name), " ", c.note)),
    r.naive?.length
      ? el("details", { class: "rawreveal" },
          el("summary", { class: "rawreveal__summary" }, "naive (uncorrected) coefficients"),
          table.render({
            caption: "Naive coefficients",
            columns: [
              { key: "name", label: "term" },
              { key: "est", label: "est", numeric: true, format: (v) => fmt(v, 3) },
              { key: "se", label: "se", numeric: true, format: (v) => fmt(v, 3) },
            ],
            rows: r.naive,
          }))
      : null));
}

/* -- triangulation: {instruments, n, percentAgreement, kappa, divergent, pairs} -- */
function triangulationResult(canvas, params, analysis) {
  const r = analysis.results ?? {};
  const [a, b] = r.instruments ?? [];

  canvas.append(section("Triangulation",
    el("p", { class: "screen__hint" },
      el("span", { class: "data" }, a?.name ?? "A"), " vs ", el("span", { class: "data" }, b?.name ?? "B"),
      el("span", { class: "data faint" },
        ` · ${fmtCount(r.n)} jointly labeled · ${fmtStat(r.percentAgreement)} raw agree · κ ${fmtStat(r.kappa)}`))));

  // numeric pairs (continuous constructs) earn the scatter; categorical
  // labels go straight to the divergence browser
  const numericPairs = (r.pairs ?? []).filter((p) => typeof p.a === "number" && typeof p.b === "number");
  if (numericPairs.length >= 3) {
    const cell = el("div", {});
    scatter.render(cell, numericPairs.map((p) => ({ x: p.a, y: p.b, label: p.unitId, id: p.unitId })), {
      caption: `Per-unit scores — identity is agreement; strays speak signal. κ = ${fmtStat(r.kappa)}`,
      xLabel: a?.name ?? "instrument A",
      yLabel: b?.name ?? "instrument B",
      format: (v) => fmtStat(v),
    });
    canvas.append(section("Score scatter", cell));
  }

  const divergent = r.divergent ?? [];
  const browser = el("div", { class: "divbrowser" });
  if (!divergent.length) {
    browser.append(el("p", { class: "faint" }, "No divergent units — the instruments read alike here."));
  }
  for (const d of divergent.slice(0, 25)) {
    const row = el("div", { class: "divrow" },
      el("div", { class: "divrow__head" },
        el("button", { class: "refchip data evidence-door", type: "button", dataset: { evidence: d.unitId } }, String(d.unitId).slice(0, 10) + "…"),
        el("span", { class: "chip chip--machine" }, `${a?.name ?? "A"}: ${String(d.a)}`),
        el("span", { class: "chip chip--machine" }, `${b?.name ?? "B"}: ${String(d.b)}`)));
    const quoteHost = el("div", {});
    row.append(quoteHost);
    api.evidence.get(params.slug, d.unitId)
      .then((dossier) => quoteHost.append(quotecard.render({ unit: dossier.unit, compact: true, evidence: true })))
      .catch(() => {});
    browser.append(row);
  }
  canvas.append(section(`Divergence browser — ${fmtCount(divergent.length)} units where reading starts`, browser));
}

/* -- subgroup: the reliability audit — {by, positive, overall {goldN,
   percentAgreement, kappa, errorRate}, groups: [{group, n, dist, goldN,
   percentAgreement, kappa, errorRate, flagged, note?, corrected?}]}.
   Agreement is machine vs gold within each group; flagged groups sit >0.1
   below the overall. Older artifacts (no overall block) say so honestly. -- */
function subgroupResult(canvas, analysis) {
  const r = analysis.results ?? {};
  const groups = r.groups ?? [];
  const distLine = (dist) => Object.entries(dist ?? {})
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([k, n]) => `${k} ${fmtCount(n)}`)
    .join(" · ");
  const stat = (v) => (v === null || v === undefined ? "—" : fmtStat(v));
  const agreementCell = (v, row) => {
    if (v === null || v === undefined) return el("span", { class: "faint", title: row.note ?? "no gold in this group" }, "—");
    return el("span", { class: "subgroupflag" },
      el("span", { class: "data" }, fmtStat(v)),
      row.flagged ? el("span", { class: "chip chip--signal", title: "agreement sits >0.1 below the overall — read this group before trusting its numbers" }, "flagged") : null);
  };
  const audited = groups.some((g) => g.goldN !== undefined) || (r.overall && typeof r.overall === "object");
  const noted = groups.filter((g) => g.note);
  const flaggedN = groups.filter((g) => g.flagged).length;

  canvas.append(section("Subgroup reliability audit",
    el("p", { class: "screen__hint" },
      `Machine-vs-gold agreement and error rate by ${r.by ?? "group"} — a validity tool and bias check.`,
      r.overall
        ? el("span", { class: "data" },
            ` Overall: ${fmtStat(r.overall.percentAgreement)} agreement`,
            r.overall.kappa !== null && r.overall.kappa !== undefined ? ` · κ ${fmtStat(r.overall.kappa)}` : "",
            ` · ${fmtStat(r.overall.errorRate)} error over ${fmtCount(r.overall.goldN)} gold units.`)
        : null,
      r.overall
        ? el("span", { class: "faint" },
            flaggedN > 0
              ? ` ${fmtCount(flaggedN)} group${flaggedN === 1 ? "" : "s"} flagged (>0.1 below overall).`
              : " No group sits >0.1 below the overall.")
        : null),
    !audited
      ? el("p", { class: "annotation annotation--still" },
          el("span", { class: "chip chip--ghost" }, "older artifact"),
          " This subgroup analysis predates the reliability audit — it carries label distributions only. Re-run it from the builder to get agreement and error rates by group.")
      : null,
    table.render({
      caption: `Reliability by ${r.by ?? "group"}`,
      columns: [
        { key: "group", label: r.by ?? "group" },
        { key: "n", label: "n", numeric: true, format: (v) => fmtCount(v), evidence: (row) => doorIds(analysis, String(row.group)) },
        { key: "goldN", label: "gold n", numeric: true, format: (v) => (v === undefined ? "—" : fmtCount(v)) },
        { key: "percentAgreement", label: "agreement", numeric: true, format: agreementCell },
        { key: "kappa", label: "κ", numeric: true, format: stat },
        { key: "errorRate", label: "error", numeric: true, format: stat },
        { key: "dist", label: "top labels", sortable: false, format: (v) => distLine(v) },
        { key: "corrected", label: "corrected ◉", numeric: true, format: (v) => (v ? fmtStat(v.est) : "—"), level: (row) => (row.corrected ? "corrected" : null) },
        { key: "corrected", label: "95% CI", numeric: true, sortable: false, format: (v) => (v ? `[${fmtStat(v.ciLo)}, ${fmtStat(v.ciHi)}]` : "—") },
      ],
      rows: groups,
      empty: {
        title: "No groups to audit.",
        hint: "The audit needs a run over units that carry this metadata key — and a complete gold set to compare against.",
      },
    }),
    ...noted.map((g) =>
      el("p", { class: "annotation annotation--still faint" },
        el("span", { class: "chip chip--ghost" }, g.group), " ", g.note))));
  correctedCellsBlock(canvas, analysis);
}

/* ================= export to report ====================================================== */

function addToReport(params, analysis) {
  const blocks = store.get("report.blocks") ?? [];
  blocks.push({
    id: `blk_${Date.now().toString(36)}`,
    type: analysis.kind === "model" ? "table" : "chart",
    source: "analysis",
    analysisId: analysis.id,
    title: `${analysis.kind} · ${analysis.id}`,
    level: analysis.level,
  });
  store.set("report.blocks", blocks);
  toast.success("Added to the report canvas.", {
    detail: `${analysis.kind} — arrange it under Reports`,
  });
}
