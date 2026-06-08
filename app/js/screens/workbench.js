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

import { el, clear, frag } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import { cite } from "../components/cite.js";
import * as ladderC from "../components/ladder.js";
import * as bar from "../components/charts/bar.js";
import * as scatter from "../components/charts/scatter.js";
import * as table from "../components/table.js";
import * as quotecard from "../components/quotecard.js";
import * as scopechip from "../components/scopechip.js";
import { store } from "../state.js";
import { fmt, fmtStat, fmtP, fmtCount, fmtDate } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, emptyState } from "./_shared.js";

export const route = "p/:slug/analyses";
export const routes = ["p/:slug/analyses", "p/:slug/analyses/:id"];
export const title = "Workbench";

const KINDS = [
  { value: "descriptive", label: "Descriptive", hint: "prevalence, distributions" },
  { value: "crosstab", label: "Crosstab", hint: "construct × metadata, χ² honesty, DSL when gold exists" },
  { value: "model", label: "Model", hint: "OLS / logistic with sandwich SEs" },
  { value: "triangulation", label: "Triangulation", hint: "agreement between two instruments, with the units they label differently" },
  { value: "subgroup", label: "Subgroup audit", hint: "machine-vs-gold agreement and error rates by group — needs a complete gold set" },
];

export function render(mount, params, query = {}) {
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
    // The variable pickers read the REAL columns of the corpus the analysis
    // will compute over: the preset run's corpus when ?runId= rode in, else
    // the most recent complete run's (what pickRun resolves to server-side),
    // else the most recently created corpus.
    const runs = project.runs ?? [];
    const presetRun = query?.runId ? runs.find((r) => r.id === query.runId) ?? null : null;
    const scopeRun = presetRun
      ?? [...runs].reverse().find((r) => r.status === "complete")
      ?? runs.at(-1) ?? null;
    const columnsCorpusId = scopeRun?.corpusId ?? (project.corpora ?? []).at(-1)?.id ?? null;
    const columns = columnsCorpusId
      ? await api.corpora.columns(params.slug, columnsCorpusId)
          .then((res) => res?.columns ?? [])
          .catch(() => [])
      : [];
    return { project, analysis, columns, columnsCorpusId };
  }, ({ project, analysis, columns, columnsCorpusId }) => {
    mount.append(screenHead({
      overline: "Workbench",
      title: "Analyze what the runs measured.",
      lede: "Pick an analysis kind on the left, choose variables, and run it over a measured corpus. When a complete human gold sample with recorded π exists, estimates are bias-corrected (◉) and the naive number is shown hatched beside them. Every analysis reads the labeled outputs of one run.",
    }));

    const split = el("div", { class: "split split--workbench" });
    mount.append(split);

    /* -- builder rail -- */
    const rail = el("div", { class: "split__list wb-rail" });
    split.append(rail);
    const canvas = el("div", { class: "split__main wb-canvas" });
    split.append(canvas);

    // arriving from a run (Explorer / run detail "Analyze →") carries
    // ?runId= — the builder pins new analyses to that run's outputs
    const presetRunId = query?.runId && (project.runs ?? []).some((r) => r.id === query.runId)
      ? query.runId : null;
    builderRail(rail, canvas, params, project, presetRunId, { columns, columnsCorpusId });

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
      renderResult(canvas, params, analysis, project);
    } else if (analysis) {
      canvas.append(emptyState({
        title: `${analysis.kind} analysis · ${analysis.id}`,
        body: "Its computed artifact is no longer on disk — recompute it from the builder to read the numbers. Recompute re-reads the stored outputs — no model calls.",
        hint: `level: ${analysis.level}`,
      }));
    } else if (!params.id) {
      canvas.append(emptyState({
        title: "No analysis selected.",
        body: "Pick a kind on the left, choose variables, and run. Results appear here. Every number is clickable down to the units behind it.",
        hint: "where a gold sample with π exists, estimates are corrected (◉) and the naive number is shown beside them.",
      }));
    } else {
      canvas.append(emptyState({ title: "Analysis not found.", body: "It may not have been computed yet." }));
    }
  }, "Opening the workbench…");
}

/* ================= builder ============================================================== */

/** "dept — categorical · 6 values" — the option label every picker uses. */
export function columnOptionLabel(col) {
  const parts = [col.role ?? "column"];
  if (col.distinct !== undefined && col.distinct !== null) {
    parts.push(`${fmtCount(col.distinct)} value${col.distinct === 1 ? "" : "s"}`);
  }
  if (col.missing) parts.push(`${fmtCount(col.missing)} missing`);
  return `${col.name} — ${parts.join(" · ")}`;
}

/** Columns whose role fits a picker. roles = ["categorical","numeric",…]. */
export function columnsForRoles(columns, roles) {
  return (columns ?? []).filter((c) => roles.includes(c.role));
}

function builderRail(rail, canvas, params, project, presetRunId = null, { columns = [], columnsCorpusId = null } = {}) {
  let kind = "crosstab";
  const constructs = project.constructs ?? [];
  const instruments = project.instruments ?? [];

  /* -- which run the builder reads ------------------------------------------
     Every analysis reads ONE run's labeled outputs. The picker holds the
     complete runs; ?runId= (a run's "Analyze →") presets it, the latest
     complete run is the default, and withRun() sends the selection with
     every run-backed spec. No complete runs → nothing to analyze yet. */
  const completeRuns = (project.runs ?? []).filter((r) => r.status === "complete");
  const hasRuns = completeRuns.length > 0;
  let selectedRunId = completeRuns.some((r) => r.id === presetRunId)
    ? presetRunId
    : completeRuns.at(-1)?.id ?? null;

  const runOptionLabel = (r) => {
    // the run's NAME leads when it has one; legacy runs derive the same facts
    let base = r.name ?? null;
    if (!base) {
      const instName = instruments.find((i) => i.id === r.instrumentId)?.name ?? r.instrumentId ?? r.id;
      const corpus = (project.corpora ?? []).find((c) => c.id === r.corpusId) ?? null;
      const corpusName = corpus ? scopechip.displayName(corpus) : r.corpusId ?? "corpus not recorded";
      base = `${instName} on ${corpusName}`;
    }
    const units = r.checkpoint?.total ?? r.checkpoint?.done ?? null;
    return `${base} — ${units === null ? "—" : fmtCount(units)} units · ${fmtDate(r.finishedAt ?? r.createdAt)}`;
  };
  const runSel = el("select", { class: "input", "aria-label": "Run whose outputs new analyses read" },
    ...completeRuns.map((r) => el("option", { value: r.id, selected: r.id === selectedRunId }, runOptionLabel(r))));
  runSel.addEventListener("change", () => {
    selectedRunId = runSel.value;
    // re-enter the screen pinned to the chosen run so the variable pickers
    // reload that run's corpus columns
    router.navigate(`p/${params.slug}/analyses?runId=${encodeURIComponent(selectedRunId)}`);
  });
  const runPickerNodes = hasRuns
    ? [varField("reads run", runSel)]
    : [
        el("p", { class: "screen__hint" },
          "Analyses read a run's outputs. Nothing has been measured yet — start a run first."),
        el("a", { class: "btn", href: `#/p/${params.slug}/runs` }, "Go to Runs →"),
      ];

  // Variable pickers list the corpus's REAL metadata columns — never a
  // canned list. Discrete pickers (crosstab axes, subgroup splits) take
  // categorical and numeric roles; model predictors take numeric only.
  const discreteCols = columnsForRoles(columns, ["categorical", "numeric"]);
  const numericCols = columnsForRoles(columns, ["numeric"]);
  const columnsCorpus = (project.corpora ?? []).find((c) => c.id === columnsCorpusId) ?? null;

  // a picker with no usable columns says so instead of inventing variables
  const emptyOption = (why) => el("option", { value: "", disabled: true, selected: true }, why);
  const columnSelect = (ariaLabel, cols, { lead = null, why = "no metadata columns detected" } = {}) => {
    const options = [];
    if (lead) options.push(el("option", { value: lead.value, selected: true }, lead.label));
    if (cols.length) options.push(...cols.map((c, i) => el("option", { value: c.name, selected: !lead && i === 0 }, columnOptionLabel(c))));
    else if (!lead) options.push(emptyOption(why));
    return el("select", { class: "input", "aria-label": ariaLabel }, ...options);
  };

  const constructSel = el("select", { class: "input", "aria-label": "Construct" },
    ...constructs.map((c) => el("option", { value: c.id }, c.name)));
  const rowSel = columnSelect("Crosstab rows", discreteCols,
    { lead: { value: "label", label: "label — the construct's measured label" } });
  const colSel = columnSelect("Crosstab columns", discreteCols);
  const bySel = columnSelect("Subgroup split", discreteCols);
  const xSel = columnSelect("Model predictor", numericCols, { why: "no numeric columns detected" });
  const instASel = el("select", { class: "input", "aria-label": "Instrument A" },
    ...instruments.map((i) => el("option", { value: i.id }, i.name)));
  const instBSel = el("select", { class: "input", "aria-label": "Instrument B" },
    ...instruments.map((i, idx) => el("option", { value: i.id, selected: idx === 1 }, i.name)));

  // no measured outputs to analyze → the whole builder waits on a run
  if (!hasRuns) {
    for (const sel of [constructSel, rowSel, colSel, bySel, xSel, instASel, instBSel]) sel.disabled = true;
  }

  const instrumentForConstruct = () =>
    instruments.find((i) => i.constructId === constructSel.value)?.id;

  // honesty about where the variables come from — and about their absence
  const columnsLine = columnsCorpus && columns.length
    ? el("p", { class: "screen__hint faint" },
        "Variables are ", el("span", { class: "data" }, scopechip.displayName(columnsCorpus)),
        "'s metadata columns — each option states its role and distinct values.")
    : null;
  const noColumnsHint = () => el("p", { class: "screen__hint faint" },
    columns.length
      ? "No column of the right role exists for this picker."
      : `No metadata columns came back${columnsCorpus ? ` for ${scopechip.displayName(columnsCorpus)}` : columnsCorpusId ? ` for ${columnsCorpusId}` : " — run an instrument or import a corpus first"}. Re-import with metadata columns to slice by them.`);

  const variableHost = el("div", { class: "wb-vars" });
  const paintVars = () => {
    clear(variableHost);
    if (kind === "triangulation") {
      variableHost.append(
        el("p", { class: "screen__hint faint" },
          "Triangulation ignores the run picker above — it reads each instrument's latest complete run on the corpus."),
        varField("instrument A", instASel),
        varField("instrument B", instBSel));
    } else if (kind === "subgroup") {
      variableHost.append(
        varField("instrument", instASel),
        varField("split by", bySel),
        discreteCols.length ? null : noColumnsHint());
    } else if (kind === "descriptive") {
      variableHost.append(varField("construct", constructSel));
    } else if (kind === "model") {
      variableHost.append(
        varField("construct", constructSel),
        varField("predictor (numeric column)", xSel),
        numericCols.length ? null : noColumnsHint());
    } else {
      variableHost.append(
        varField("construct", constructSel),
        varField("rows", rowSel),
        varField("columns", colSel),
        discreteCols.length ? null : noColumnsHint());
    }
    paintRunState();
  };

  // a kind whose required variable has no real column cannot run — say why
  // on the button instead of letting the server 400
  const missingVariable = () => {
    if (!hasRuns) return "analyses read a run's outputs — start a run first";
    if (kind === "crosstab" && !colSel.value) return "crosstab needs a metadata column";
    if (kind === "subgroup" && !bySel.value) return "the subgroup audit needs a metadata column";
    if (kind === "model" && !xSel.value) return "the model needs a numeric column";
    if ((kind === "triangulation") && instruments.length < 2) return "triangulation needs two instruments";
    if (kind !== "crosstab" && kind !== "triangulation" && constructs.length === 0) return "write a construct first";
    return null;
  };
  const paintRunState = () => {
    const missing = missingVariable();
    runBtn.disabled = Boolean(missing);
    runBtn.title = missing ?? "";
  };

  const kindList = el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Analysis kind" } },
    ...KINDS.map((k) =>
      el("label", { class: "choice" },
        el("input", {
          type: "radio", name: "wbkind", value: k.value, checked: kind === k.value,
          disabled: !hasRuns,
          onchange: () => { kind = k.value; paintVars(); },
        }),
        el("span", { class: "choice__text" },
          el("span", { class: "choice__label" }, k.label),
          el("span", { class: "choice__hint" }, k.hint)))));

  // live spec shapes per kind (see header contract); the run picker's
  // selection rides every run-backed spec as the pickRun hint
  const withRun = (spec) => (selectedRunId ? { runId: selectedRunId, ...spec } : spec);
  const specFor = () => {
    if (kind === "triangulation") return { instrumentIds: [instASel.value, instBSel.value] };
    if (kind === "subgroup") return withRun({ instrumentId: instASel.value, by: bySel.value });
    const instrumentId = instrumentForConstruct();
    if (kind === "model") return withRun({ x: [xSel.value], family: "logit", ...(instrumentId ? { instrumentId } : {}) });
    if (kind === "crosstab") return withRun({ rowKey: rowSel.value || "label", colKey: colSel.value, ...(instrumentId ? { instrumentId } : {}) });
    return withRun(instrumentId ? { instrumentId } : {});
  };

  const runBtn = el("button", {
    class: "btn btn--primary wb-run", type: "button",
    onclick: async () => {
      runBtn.disabled = true;
      clear(canvas).append(el("p", { class: "faint", role: "status" }, "computing — DSL applies automatically where gold with π exists…"));
      try {
        const analysis = await api.analyses.create(params.slug, { kind, spec: specFor() });
        clear(canvas);
        renderResult(canvas, params, analysis, project);
        toast.success("Analysis computed.", { detail: `${kind} · ${analysis.level}`, data: true });
      } catch (err) {
        clear(canvas).append(emptyState({ title: "The analysis failed.", body: String(err.message ?? err) }));
      }
      runBtn.disabled = false;
    },
  }, "Run analysis");

  paintVars();
  rail.append(frag(
    el("h3", { class: "overline split__group" }, "Build"),
    ...runPickerNodes,
    columnsLine,
    kindList,
    variableHost,
    runBtn,
  ));

  function varField(label, control) {
    return el("label", { class: "field" },
      el("span", { class: "field__label overline" }, label),
      control);
  }
}

/* ================= results ============================================================== */

function renderResult(canvas, params, analysis, project = null) {
  const level = analysis.level ?? "exploratory";

  canvas.append(el("header", { class: "wb-resulthead" },
    el("h3", { class: "wb-resulttitle" },
      `${analysis.kind} analysis`,
      " ", ladderC.render({ level, size: "md", label: true })),
    el("button", {
      class: "btn btn--quiet", type: "button",
      onclick: () => addToReport(params, analysis),
    }, "Add to report →")));

  /* -- scope: which corpus/column/rows these numbers were computed over.
     No corpus in the spec (triangulation reads per-instrument runs) → NO
     chip: a guessed corpora[0] would claim a scope nothing computed over. -- */
  const scopeCorpusId = analysis.spec?.corpusId
    ?? (project?.runs ?? []).find((r) => r.id === analysis.spec?.runId)?.corpusId
    ?? null;
  const corpusEntry = (project?.corpora ?? []).find((c) => c.id === scopeCorpusId) ?? null;
  const scope = scopechip.fromCorpus(corpusEntry, project);
  if (scope) canvas.append(el("div", { class: "scopebar" }, scopechip.render(scope)));

  /* -- server-side honesty notes (e.g. uncertainty-design gold: π nominal,
     no design-based correction) render before any number -- */
  if (typeof analysis.results?.note === "string" && analysis.results.note) {
    canvas.append(el("p", { class: "annotation annotation--still" },
      el("span", { class: "chip chip--signal" }, "note"), " ", analysis.results.note));
  }

  if (analysis.kind === "crosstab") crosstabResult(canvas, analysis);
  else if (analysis.kind === "model") modelResult(canvas, analysis);
  else if (analysis.kind === "triangulation") triangulationResult(canvas, params, analysis);
  else if (analysis.kind === "subgroup") subgroupResult(canvas, analysis);
  else descriptiveResult(canvas, analysis, project);
}

const cellsOf = (analysis) => analysis.evidence?.cells ?? {};
const doorIds = (analysis, key) => {
  const ids = cellsOf(analysis)[key];
  return ids?.length ? ids : null;
};

/* -- descriptive: {n, distribution: {label: {n, share, corrected: false}}}.
   The distribution is the RAW machine-label proportion (the server stamps
   corrected: false on every entry) — it must NEVER wear the analysis's
   corrected ◉: only results.cells holds DSL-corrected numbers, and they
   render in the Correction Reveal below. Raw bars wear the instrument's own
   level instead (or no mark when it cannot be resolved). -- */
function descriptiveResult(canvas, analysis, project = null) {
  const r = analysis.results ?? {};
  const entries = Object.entries(r.distribution ?? {});
  if (!entries.length) {
    canvas.append(emptyState({ title: "Nothing to describe.", body: "Run an instrument first." }));
    return;
  }
  const hasCorrected = Boolean(r.cells?.length && r.estimator);
  const instrument = (project?.instruments ?? []).find((i) => i.id === analysis.spec?.instrumentId) ?? null;
  const rawLevel = analysis.level === "corrected" ? (instrument?.level ?? null) : analysis.level;
  const cell = el("div", {});
  bar.render(cell, entries.map(([label, d]) => ({
    label,
    value: d.share,
    level: rawLevel,
    evidence: doorIds(analysis, label) ?? undefined,
    evidenceTotal: d.n,
  })), {
    caption: `Raw machine-label shares over ${fmtCount(r.n)} units — every bar opens its units`
      + (hasCorrected ? "; the corrected estimates are in the Correction Reveal below" : ""),
    format: (v) => fmtStat(v),
    level: rawLevel,
    domain: [0, 1],
  });
  canvas.append(section(hasCorrected ? "Distribution — raw machine labels" : "Distribution", cell));
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
                    // evidenceTotal: the TRUE cell count — evidence ids cap at
                    // 100, and the inspector says "first 100 of N" when capped
                    ? el("button", { class: "evidence-door table__doorbtn", type: "button", dataset: { evidence: ids.join(","), evidenceTotal: String(t.matrix[i][j]) } }, text)
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
          ? el("span", { class: "chip chip--signal", title: "Expected cell counts under 5 degrade the χ² approximation — a standard rule of thumb (Cochran's), not a hard gate" }, "small-n warning")
          : null),
      ...(r.warnings ?? []).map((w) =>
        el("p", { class: "annotation annotation--still" },
          el("span", { class: "chip chip--signal" }, w.kind ?? "note"), " ", w.message ?? String(w)))));
  }

  // In a corrected analysis the contingency table and its χ²/df/p are STILL
  // computed on raw machine labels — only results.cells carries DSL-corrected
  // numbers. The per-analysis ◉ badge sits above, so this section must say
  // which numbers it covers.
  if (level === "corrected" && r.cells?.length) {
    canvas.append(el("p", { class: "annotation annotation--still" },
      "The table and χ² above are computed on ", el("strong", {}, "raw machine labels"),
      "; the corrected shares (◉) are in the Correction Reveal below."));
  }

  correctedCellsBlock(canvas, analysis);

  if (!(level === "corrected" && r.cells?.length)) {
    canvas.append(el("p", { class: "annotation annotation--still" },
      "These cells are ", el("strong", {}, "uncorrected"), " (", ladderC.mark(level), " ", level, "). A gold sample with stored π would let design-based supervised learning (DSL", cite("egami2023"), ") remove machine-error bias — the uncorrected level mark stays on these numbers in every export until a gold sample with π is provided."));
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
      " Corrected for machine-labeling error using the gold sample — design-based supervised learning (DSL", cite("egami2023"),
      "), of the prediction-powered-inference family", cite("angelopoulos2023"),
      ". Higher machine accuracy improves precision (narrower CIs) but does not remove bias; validity comes from the gold sample."),
    ...(r.skippedGroups ?? []).map((s) =>
      el("p", { class: "annotation annotation--still faint" },
        el("span", { class: "chip chip--ghost" }, s.group), " ", s.reason))));
}

/* The coefficient forest — corrected estimate (solid ◉, 95% CI from ±1.96·se)
   beside the naive plug-in (hatched), the zero line as the reference. Reuses
   bar.js paired mode, the Correction Reveal primitive: the corrected bar runs
   from zero to its estimate with a CI whisker, the naive bar hatched beneath,
   Δ annotated per row. No new server math — est/se already ride r.coef/r.naive.
   The intercept is dropped from the PLOT when there are other terms (its
   magnitude would crush the slopes' visual range); the table keeps every term.
   Returns null when there is nothing to draw. */
const INTERCEPT_NAMES = new Set(["(intercept)", "intercept", "const", "_cons", "constant"]);
function coefficientForest(analysis) {
  const r = analysis.results ?? {};
  const coef = (r.coef ?? []).filter((c) => typeof c.est === "number" && Number.isFinite(c.est));
  if (coef.length === 0) return null;
  const naiveByName = new Map((r.naive ?? []).map((c) => [c.name, c]));

  // drop the intercept from the plot only when slopes exist beside it
  const hasSlopes = coef.some((c) => !INTERCEPT_NAMES.has(String(c.name).toLowerCase()));
  const plotted = hasSlopes ? coef.filter((c) => !INTERCEPT_NAMES.has(String(c.name).toLowerCase())) : coef;
  if (plotted.length === 0) return null;

  const rows = plotted.map((c) => {
    const se = typeof c.se === "number" && Number.isFinite(c.se) ? c.se : null;
    const naive = naiveByName.get(c.name);
    return {
      label: c.name,
      corrected: { value: c.est, ...(se !== null && se > 0 ? { ci: [c.est - 1.96 * se, c.est + 1.96 * se] } : {}) },
      naive: { value: typeof naive?.est === "number" ? naive.est : undefined },
      level: "corrected",
    };
  });

  const host = el("div", { class: "wb-coefforest" });
  bar.render(host, rows, {
    paired: true,
    domain: null, // auto — spans the estimates and their CIs, so the zero line lands naturally
    format: (v) => fmt(v, 3),
    caption: `Coefficient forest — corrected ◉ with 95% CI (est ± 1.96·se) solid; the naive plug-in hatched beside it; the vertical line is zero${hasSlopes && plotted.length < coef.length ? "; the intercept is in the table below" : ""}. Corrected via DSL; naive = plug-in.`,
  });
  return host;
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
    coefficientForest(analysis),
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
      caption: `Per-unit scores — points on the diagonal are units the two instruments scored equally; points off it are units they scored differently. κ = ${fmtStat(r.kappa)}`,
      xLabel: a?.name ?? "instrument A",
      yLabel: b?.name ?? "instrument B",
      format: (v) => fmtStat(v),
    });
    canvas.append(section("Score scatter", cell));
  }

  const divergent = r.divergent ?? [];
  const divergentN = r.divergentN ?? divergent.length; // the TRUE count (the list is capped server-side)
  const browser = el("div", { class: "divbrowser" });
  if (!divergent.length) {
    browser.append(el("p", { class: "faint" }, "No divergent units. The two instruments assigned the same labels for every jointly labeled unit."));
  } else if (divergentN > 25) {
    browser.append(el("p", { class: "screen__hint faint" },
      `Showing the first 25 of ${fmtCount(divergentN)} divergent units.`));
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
  canvas.append(section(`Divergence browser — ${fmtCount(divergentN)} units the instruments label differently`, browser));
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
      `Machine-vs-gold agreement and error rate by ${r.by ?? "group"} — used to check validity and detect group bias.`,
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

async function addToReport(params, analysis) {
  // The report canvas is a PERSISTED project artifact (project.report.blocks).
  // Append through the server so the block survives a reload and reaches the
  // server-side HTML export — the canonical block schema is {kind, ref?,
  // content?} (server validateReportBlock / reporting/report.js), keyed by the
  // analysis id under `ref`.
  //
  // A model fit with plottable coefficients exports as a CHART block — the
  // server renders its coefficient forest as publication-grade SVG (report.js
  // rowsFrom maps coef → bars with CI from est±1.96·se). Models without numeric
  // coefficients fall back to a table; everything else is already a chart.
  const modelPlottable = analysis.kind === "model"
    && (analysis.results?.coef ?? []).some((c) => typeof c.est === "number" && Number.isFinite(c.est));
  const block = {
    kind: analysis.kind === "model" && !modelPlottable ? "table" : "chart",
    ref: analysis.id,
    title: analysis.name ?? `${analysis.kind} · ${analysis.id}`,
    level: analysis.level,
  };
  try {
    const updated = await api.report.addBlock(params.slug, block);
    // keep the session's canvas mirror AND the cached project graph in step
    // with the server, so the Reports screen opens with this block present
    const blocks = store.get("report.blocks") ?? [];
    blocks.push(block);
    store.set("report.blocks", blocks);
    const cached = store.get("project");
    if (cached?.slug === params.slug) {
      cached.report = cached.report ?? { blocks: [], updatedAt: null };
      cached.report.blocks = [...(cached.report.blocks ?? []), { ...block, addedAt: new Date().toISOString() }];
      cached.report.updatedAt = new Date().toISOString();
    }
    toast.success("Added to the report canvas.", {
      detail: `${updated.blocks} block${updated.blocks === 1 ? "" : "s"} now — arrange and export under Reports`,
    });
  } catch (err) {
    toast.error("Could not add to the report.", { detail: String(err.message ?? err) });
  }
}
