// Reliability — #/p/:slug/reliability/:cid — the home of κ. One construct,
// every reader that has applied it (human coders, adjudicated gold,
// instruments, test–retest reruns), and how much each pair agrees. The
// vs-gold column is the headline when gold exists; the full pairwise story
// is a lower-triangle heat-table whose gold row wears gold. Cells open a
// side panel with the pair's statistics and, when a corpus run exists, the
// door to its per-unit Disagreement view. Empty and partial states teach
// the path instead of going blank.
//
// Live contract (GET reliability/:constructId?corpusId=):
//   {constructId, corpusId, sources: [{key, label, kind: instrument|gold|
//   coder|retest, n, runId?, level?}], pairs: [{a, b, n, percent, kappa,
//   alpha}], notes: [string], retestAvailable?: false}

import { el, clear, frag } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as ladderC from "../components/ladder.js";
import { contextLine, corpusText } from "../components/contextline.js";
import { cite } from "../components/cite.js";
import { fmtStat, fmtCount, fmtPct } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, refreshProject, emptyState, LEVEL_PRICE } from "./_shared.js";
import { benchmarkBand } from "./calibration.js";

export const route = "p/:slug/reliability/:cid";
export const title = "Reliability";

const KIND_RANK = { coder: 0, gold: 1, instrument: 2, retest: 3 };
const KIND_CHIP = { coder: "human", gold: "gold", retest: "retest" };

/** Humans first, gold second, machines after, reruns last — stable within kinds. */
export function sortSources(sources) {
  return [...(sources ?? [])].map((s, i) => [s, i])
    .sort((x, y) => ((KIND_RANK[x[0].kind] ?? 9) - (KIND_RANK[y[0].kind] ?? 9)) || (x[1] - y[1]))
    .map(([s]) => s);
}

/** Band class for a value under the stat's convention: low | mid | high. */
export function bandClass(value, stat = "κ") {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  const lo = stat === "κ" ? 0.61 : 0.667;
  const hi = stat === "κ" ? 0.81 : 0.8;
  return value >= hi ? "high" : value >= lo ? "mid" : "low";
}

/** "retest:<instrumentId>:<index>" → instrumentId, else null. */
function retestInstrumentOf(key) {
  const m = /^retest:(.+):(\d+)$/.exec(String(key ?? ""));
  return m ? m[1] : null;
}

/** Per instrument with retest sources: {instrumentId, name, k, meanAlpha} —
    meanAlpha is the mean of α over the pairs whose BOTH keys are reruns of
    that instrument (null when no such pair carries a numeric α). */
export function retestSummaries(sources, pairs) {
  const byInst = new Map();
  for (const s of sources ?? []) {
    if (s.kind !== "retest") continue;
    const instId = retestInstrumentOf(s.key);
    if (!instId) continue;
    let info = byInst.get(instId);
    if (!info) {
      byInst.set(instId, (info = {
        instrumentId: instId,
        name: String(s.label ?? "").replace(/\s*—\s*rerun \d+ of \d+$/, "") || instId,
        k: 0,
      }));
    }
    info.k += 1;
  }
  const out = [];
  for (const info of byInst.values()) {
    const alphas = (pairs ?? [])
      .filter((p) => retestInstrumentOf(p.a) === info.instrumentId
        && retestInstrumentOf(p.b) === info.instrumentId
        && typeof p.alpha === "number" && !Number.isNaN(p.alpha))
      .map((p) => p.alpha);
    out.push({
      ...info,
      meanAlpha: alphas.length ? alphas.reduce((a, b) => a + b, 0) / alphas.length : null,
    });
  }
  return out;
}

export function render(mount, params, query = {}) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const construct = await api.constructs.get(params.slug, params.cid).catch(() => null);
    let data = null;
    let dataError = null;
    try {
      data = await api.reliability.get(params.slug, params.cid, { corpusId: query?.corpusId });
    } catch (err) {
      dataError = err;
    }
    return { project, construct, data, dataError };
  }, ({ project, construct, data, dataError }) => {
    const constructName = construct?.name ?? params.cid;
    // ordinal constructs report Krippendorff's α (order-aware); everything
    // else reports Cohen's κ — the matrix says which it is showing
    const ordinal = construct?.type === "ordinal";
    const stat = ordinal ? "α" : "κ";
    const statOf = (pair) => (ordinal ? pair.alpha ?? pair.kappa : pair.kappa ?? pair.alpha);

    mount.append(screenHead({
      overline: "Reliability",
      title: `Who agrees about “${constructName}”.`,
      lede: "Every way this construct has been read, and how much the readers agree. Humans first: human–human agreement is the ceiling any machine is measured against.",
    }));

    /* -- context: whose agreement story this is, over which corpus -- */
    const corpusId = data?.corpusId ?? query?.corpusId ?? null;
    const corpus = (project?.corpora ?? []).find((c) => c.id === corpusId) ?? null;
    mount.append(contextLine([
      {
        label: "construct",
        node: el("span", {},
          construct
            ? el("a", { class: "contextline__link", href: `#/p/${params.slug}/constructs/${encodeURIComponent(params.cid)}` }, constructName, " →")
            : el("span", { class: "contextline__text" }, constructName),
          construct?.type ? el("span", { class: "chip" }, construct.type) : null),
      },
      {
        label: "read over",
        text: corpus ? corpusText(corpus, project) : (corpusId ?? "all corpora with readings"),
        faint: !corpus,
      },
    ]));

    if (dataError) {
      mount.append(emptyState({
        title: "The reliability surface could not load.",
        body: String(dataError?.message ?? dataError),
        hint: "This screen reads GET reliability/:constructId — update or restart the Concord server if the route is missing.",
      }));
      return;
    }

    const sources = sortSources(data?.sources);
    const pairs = data?.pairs ?? [];
    const pairMap = new Map();
    for (const p of pairs) {
      pairMap.set(`${p.a}|${p.b}`, p);
      pairMap.set(`${p.b}|${p.a}`, p);
    }
    const pairOf = (a, b) => pairMap.get(`${a}|${b}`) ?? null;

    const goldSource = sources.find((s) => s.kind === "gold") ?? null;
    const instrumentSources = sources.filter((s) => s.kind === "instrument");
    const goldsetForConstruct = (project?.goldsets ?? []).find((g) => g.constructId === params.cid) ?? null;
    const firstInstrument = (project?.instruments ?? []).find((i) => i.constructId === params.cid) ?? null;

    /* ---- nothing has read this construct: teach the whole path ---- */
    if (!sources.length) {
      mount.append(emptyState({
        title: "Nothing has read this construct yet.",
        body: "Agreement needs at least two readers. Start with the human anchor — a gold sample you code by hand — then compile instruments and run them; every pair lands here.",
        hint: `Code a gold sample (${LEVEL_PRICE}) to anchor everything here.`,
        actions: [
          createGoldBtn(params, project, corpusId, "Code a gold sample"),
          el("a", { class: "btn", href: compileHref(params, params.cid) }, "Compile an instrument…"),
        ],
      }));
      appendNotes(mount, data);
      return;
    }

    /* ---- the headline: every instrument against the human gold ---- */
    if (goldSource) {
      const vsGold = instrumentSources
        .map((s) => ({ source: s, pair: pairOf(s.key, goldSource.key) }))
        .filter((r) => r.pair);
      if (vsGold.length) {
        mount.append(section("Against the human gold standard",
          el("div", { class: "vsgold" },
            ...vsGold.map(({ source, pair }) => {
              const v = statOf(pair);
              return el("div", { class: "vsgold__row" },
                el("span", { class: "vsgold__name" },
                  source.label,
                  source.level ? ladderC.render({ level: source.level, size: "sm" }) : null,
                  source.runId
                    ? el("a", { class: "vsgold__runlink data", href: `#/p/${params.slug}/runs/${encodeURIComponent(source.runId)}/disagreement`, title: "This instrument's corpus run — open its per-unit disagreements" }, source.runId)
                    : null),
                el("span", { class: `vsgold__stat data vsgold__stat--${bandClass(v, stat)}` }, `${stat} ${fmtStat(v)}`),
                el("span", { class: "vsgold__band" }, benchmarkBand(v, null, { stat, legend: false })),
                el("span", { class: "vsgold__sub data faint" }, `${fmtPct(pair.percent, 0)} raw · n = ${fmtCount(pair.n)}`));
            })),
          el("p", { class: "screen__hint faint" },
            "Gold is the adjudicated human standard — agreement with it is validity, not just consistency.")));
      }
    } else {
      /* ---- no gold yet: the one move that anchors everything ---- */
      mount.append(section("No human anchor yet",
        el("div", { class: "nudge" },
          el("span", { class: "nudge__mark", aria: { hidden: "true" } }, "◑ → ●"),
          el("p", { class: "nudge__line" },
            `Code a gold sample (${LEVEL_PRICE}) to anchor everything here — without it, instruments can only agree with each other, never be right.`),
          createGoldBtn(params, project, corpusId, "Create the gold set →", "btn btn--primary nudge__go"))));
    }

    /* ---- the matrix: sources × sources, lower triangle ---- */
    const panel = el("aside", { class: "relpanel", aria: { label: "Pair detail", live: "polite" } },
      el("p", { class: "relpanel__hint faint" }, "Click any pair in the matrix to read its detail here."));

    if (sources.length >= 2) {
      const matrix = buildMatrix({ params, sources, pairOf, stat, statOf, panel, goldsetForConstruct });
      // test–retest summary: one line per instrument with rerun rows — the
      // mean α over its rerun-vs-rerun pairs (self-consistency, not validity)
      const retestLines = retestSummaries(sources, pairs).map((r) =>
        el("p", { class: "screen__hint" },
          `Test–retest: mean rerun-vs-rerun α = ${fmtStat(r.meanAlpha)} across ${r.k} reruns of ${r.name}.`,
          cite("krippendorff2004")));
      mount.append(section("The agreement matrix",
        el("p", { class: "screen__hint" },
          `Showing ${ordinal
            ? "Krippendorff's α — this construct is ordinal, and α respects the category order"
            : "Cohen's κ — chance-corrected agreement for nominal labels"}`,
          cite(ordinal ? "krippendorff2004" : "cohen1960"),
          ". Raw agreement and n ride in each cell's subline."),
        ...retestLines,
        el("div", { class: "relsplit" },
          el("div", { class: "relsplit__main" }, matrix),
          panel),
        el("p", { class: "relmatrix__legend faint" },
          "Reading the shades — κ .61–.80 “substantial”, .81–1.00 “almost perfect”", cite("landiskoch1977"),
          " · α ≥ .800 for confident conclusions, .667–.800 for tentative ones", cite("krippendorff2004"),
          ". Bands give context, never a verdict."),
      ));
    } else {
      mount.append(section("The agreement matrix",
        el("p", { class: "screen__hint" },
          "Only ", el("strong", {}, sources[0].label), " has read this construct so far — agreement needs a second reader. ",
          goldSource ? "Compile an instrument and run it, and the pair appears here." : "Code the gold sample, or add a second instrument."),
      ));
    }

    /* ---- partial states that teach the next step ---- */
    const teach = [];
    if (instrumentSources.length === 1) {
      teach.push(el("p", { class: "relteach" },
        el("a", { class: "btn", href: compileHref(params, params.cid, true) }, "+ Same construct, another model"),
        el("span", { class: "faint" }, " a second instrument turns one reading into a reliability check — different model families catch different blind spots.")));
    }
    if (data?.retestAvailable === false) {
      teach.push(el("p", { class: "relteach relteach--quiet faint" },
        "Test–retest: ",
        firstInstrument
          ? el("a", { href: `#/p/${params.slug}/instruments/${encodeURIComponent(firstInstrument.id)}` }, "run the Stability check on an instrument")
          : el("a", { href: `#/p/${params.slug}/instruments?construct=${encodeURIComponent(params.cid)}` }, "run the Stability check on an instrument"),
        " to measure self-consistency — the same reader, the same units, read again."));
    }
    if (teach.length) mount.append(section(null, ...teach));

    appendNotes(mount, data);
  }, "Gathering every reading…");
}

/* ================= matrix ============================================================ */

function buildMatrix({ params, sources, pairOf, stat, statOf, panel, goldsetForConstruct }) {
  const cols = sources.slice(0, -1); // lower triangle: last source is row-only
  const rows = sources.slice(1);

  const sourceLabel = (s) => frag(
    s.label,
    s.kind === "instrument" && s.level ? ladderC.render({ level: s.level, size: "sm" }) : null,
    KIND_CHIP[s.kind] ? el("span", { class: `chip ${s.kind === "retest" ? "chip--ghost" : "chip--gold"}` }, KIND_CHIP[s.kind]) : null,
  );

  const table = el("table", { class: "relmatrix" },
    el("caption", { class: "sr-only" },
      `Pairwise ${stat} between every reader of this construct — ${sources.length} sources, lower triangle.`),
    el("thead", {}, el("tr", {},
      el("td", { class: "relmatrix__corner" }),
      ...cols.map((c) => el("th", {
        scope: "col",
        class: `relmatrix__collabel${c.kind === "gold" ? " relmatrix__label--gold" : ""}`,
      }, sourceLabel(c))))),
    el("tbody", {},
      ...rows.map((r, ri) => el("tr", {},
        el("th", {
          scope: "row",
          class: `relmatrix__rowlabel${r.kind === "gold" ? " relmatrix__label--gold" : ""}`,
        }, sourceLabel(r)),
        ...cols.slice(0, ri + 1).map((c) => cell(r, c))))),
  );

  function cell(a, b) {
    const pair = pairOf(a.key, b.key);
    if (!pair) {
      return el("td", { class: "relmatrix__td" },
        el("span", { class: "relcell relcell--empty faint", title: `${a.label} and ${b.label} have not read the same units yet` }, "—"));
    }
    const v = statOf(pair);
    const tint = Math.round(Math.max(0, Math.min(1, v ?? 0)) * 62);
    const goldPair = a.kind === "gold" || b.kind === "gold";
    const btn = el("button", {
      class: `relcell${goldPair ? " relcell--gold" : ""}`,
      type: "button",
      style: { "--tint": `${tint}%` },
      title: `${a.label} × ${b.label} — κ ${fmtStat(pair.kappa)} · α ${fmtStat(pair.alpha)} · ${fmtPct(pair.percent, 0)} raw agreement · n = ${fmtCount(pair.n)}`,
      aria: { label: `${a.label} and ${b.label}: ${stat} ${fmtStat(v)}, ${fmtPct(pair.percent, 0)} raw agreement over ${fmtCount(pair.n)} units — open the pair detail` },
      onclick: () => paintPair(panel, params, { a, b, pair, stat, value: v, goldsetForConstruct }),
    },
      el("span", { class: "relcell__value data" }, fmtStat(v)),
      el("span", { class: "relcell__sub data" }, `${fmtPct(pair.percent, 0)} · n ${fmtCount(pair.n)}`));
    return el("td", { class: "relmatrix__td" }, btn);
  }

  return el("figure", { class: "relmatrix-wrap" },
    table,
    el("figcaption", { class: "relmatrix__caption faint" },
      el("span", { class: "overline" }, "sources × sources"),
      ` ${stat} per pair · the gold row wears gold · — means the two never read the same units`));
}

/* ================= pair detail panel ================================================== */

function paintPair(panel, params, { a, b, pair, stat, value, goldsetForConstruct }) {
  const runLinks = [a, b].filter((s) => s.runId).map((s) =>
    el("p", { class: "relpanel__link" },
      el("a", { href: `#/p/${params.slug}/runs/${encodeURIComponent(s.runId)}/disagreement` },
        `Per-unit disagreements — ${s.label} →`),
      el("span", { class: "faint" }, ` run ${s.runId}`)));
  const goldInPair = a.kind === "gold" || b.kind === "gold";
  const goldLink = goldInPair && goldsetForConstruct
    ? el("p", { class: "relpanel__link" },
        el("a", { href: `#/p/${params.slug}/goldsets/${encodeURIComponent(goldsetForConstruct.id)}?pane=test` },
          "Confusion vs gold — Calibration Test pane →"))
    : null;

  clear(panel).append(
    el("h4", { class: "relpanel__title" }, a.label, " × ", b.label),
    el("dl", { class: "kvlist" },
      el("div", { class: "kv" }, el("dt", { class: "kv__label overline" }, "κ"), el("dd", { class: "kv__value data" }, fmtStat(pair.kappa))),
      el("div", { class: "kv" }, el("dt", { class: "kv__label overline" }, "α"), el("dd", { class: "kv__value data" }, fmtStat(pair.alpha))),
      el("div", { class: "kv" }, el("dt", { class: "kv__label overline" }, "raw agreement"), el("dd", { class: "kv__value data" }, fmtPct(pair.percent, 1))),
      el("div", { class: "kv" }, el("dt", { class: "kv__label overline" }, "jointly read"), el("dd", { class: "kv__value data" }, `${fmtCount(pair.n)} units`))),
    benchmarkBand(value, null, { stat, legend: false }),
    runLinks.length || goldLink
      ? frag(...runLinks, goldLink,
          el("p", { class: "relpanel__note faint" }, "Per-unit labels live behind those doors; this panel carries the pair's statistics."))
      : el("p", { class: "relpanel__note faint" },
          "Pair statistics only — neither side has a corpus run, so there is no per-unit disagreement view to open. Calibration passes keep per-unit labels server-side."),
  );
}

/* ================= shared helpers ===================================================== */

function appendNotes(mount, data) {
  for (const note of data?.notes ?? []) {
    mount.append(el("p", { class: "annotation annotation--still faint" },
      el("span", { class: "chip chip--ghost" }, "note"), " ", note));
  }
}

/** instruments?construct=<id>&compile=1|new — `new` forces the sheet open
    even when the construct already has instruments (the "+ another model"
    door); `1` keeps the original first-instrument handoff semantics. */
function compileHref(params, constructId, another = false) {
  return `#/p/${params.slug}/instruments?construct=${encodeURIComponent(constructId)}&compile=${another ? "new" : "1"}`;
}

function createGoldBtn(params, project, corpusId, label, cls = "btn btn--primary") {
  // a goldset for this construct may exist but carry no adjudicated gold yet
  // (status sampling/coding) — reuse it rather than minting a duplicate
  const existing = (project?.goldsets ?? []).find((g) => g.constructId === params.cid) ?? null;
  if (existing) {
    return el("a", { class: cls, href: `#/p/${params.slug}/goldsets/${encodeURIComponent(existing.id)}` },
      label.replace(/^Create the gold set/, "Finish the gold set"));
  }
  return el("button", {
    class: cls, type: "button",
    onclick: async (e) => {
      e.target.disabled = true;
      try {
        const created = await api.goldsets.create(params.slug, {
          constructId: params.cid,
          corpusId: corpusId ?? undefined,
        });
        toast.success("Gold set created.", { detail: "draw the sample, then code it blind", data: false });
        await refreshProject(params.slug).catch(() => {});
        router.navigate(`p/${params.slug}/goldsets/${created.id}`);
      } catch (err) {
        e.target.disabled = false;
        toast.error("Could not create the gold set.", { detail: String(err.message ?? err) });
      }
    },
  }, label);
}
