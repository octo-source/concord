// Calibration Studio — #/p/:slug/goldsets/:gid — where machine reading earns
// the right to be believed. Four panes follow the goldset's life:
//   Sample     design picker (SRS/stratified/uncertainty), n with guidance, π note
//   Code       THE SPRINT — full-bleed, large-type serif unit, pinned definition,
//              j/k travel, number keys label, u can't-code, f flags, m memos,
//              progress + timer, and one quiet typographic completion moment.
//              No confetti.
//   Test       human–human κ/α FIRST (with CI and benchmark band), then
//              per-instrument columns with clickable confusion heat-tables,
//              iteration log with κ sparkline and the McNemar honesty note.
//   Adjudicate disagreement queue, side-by-side coder labels, pick-or-enter.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as toast from "../components/toast.js";
import { cite } from "../components/cite.js";
import * as confusion from "../components/confusion.js";
import * as forest from "../components/charts/forest.js";
import * as quotecard from "../components/quotecard.js";
import * as ladderC from "../components/ladder.js";
import * as renameable from "../components/renameable.js";
import { contextLine, corpusText } from "../components/contextline.js";
import { fmtStat, fmtCount, fmtClock } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, refreshProject, emptyState, openSheet, setFullbleed, goldsetDisplayName } from "./_shared.js";

export const route = "p/:slug/goldsets/:gid";
export const title = "Calibration Studio";

const PANES = ["sample", "code", "test", "adjudicate"];

let sprintCleanup = null;

/* An uncodable mark is a verdict too — a distinct pseudo-value, never a gold
   label. It renders as "can't code" and a split against a real label IS a
   disagreement. */
export const UNCODABLE = "__uncodable__";

/** A coder's can't-code marks, tolerant of array or {unitId: true} shapes. */
function uncodableSetOf(coder) {
  const u = coder?.uncodable;
  if (Array.isArray(u)) return new Set(u);
  if (u && typeof u === "object") return new Set(Object.keys(u).filter((k) => u[k]));
  return new Set();
}

/** Adjudicator-excluded units (out of gold permanently), array or map shape. */
export function isExcluded(goldset, unitId) {
  const ex = goldset?.excluded;
  if (Array.isArray(ex)) return ex.includes(unitId);
  if (ex && typeof ex === "object") return Boolean(ex[unitId]);
  return false;
}

/* The live goldset artifact carries no disagreement list — the queue is
   DERIVED: units where ≥2 coders gave verdicts (a label or an uncodable mark)
   and split, PLUS units where every verdict is can't-code — those can never
   become consensus gold, so without a human disposition (a label or an
   exclusion) they would block the set forever. Resolved when an adjudicated
   label exists, settled also when the adjudicator excluded the unit from gold.
   {unitId, labels: {coderId: label | UNCODABLE}, resolved, excluded} */
export function disagreementsOf(goldset) {
  const coders = (goldset.coders ?? []).map((c) => ({ rec: c, uncodable: uncodableSetOf(c) }))
    .filter(({ rec, uncodable }) => (rec.labels && Object.keys(rec.labels).length > 0) || uncodable.size > 0);
  const out = [];
  for (const s of goldset.sample ?? []) {
    const labels = {};
    for (const { rec, uncodable } of coders) {
      if (uncodable.has(s.unitId)) labels[rec.coderId] = UNCODABLE;
      else if (rec.labels?.[s.unitId] !== undefined) labels[rec.coderId] = rec.labels[s.unitId];
    }
    const verdicts = Object.values(labels);
    const values = verdicts.map((v) => JSON.stringify(v));
    const split = values.length >= 2 && new Set(values).size > 1;
    const allUncodable = verdicts.length >= 1 && verdicts.every((v) => v === UNCODABLE);
    if (split || allUncodable) {
      out.push({
        unitId: s.unitId,
        labels,
        resolved: goldset.adjudicated?.[s.unitId] ?? null,
        excluded: isExcluded(goldset, s.unitId),
      });
    }
  }
  return out;
}

export function render(mount, params, query) {
  const state = { pane: query.pane ?? null };
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const [goldset, constructs] = await Promise.all([
      api.goldsets.get(params.slug, params.gid),
      api.constructs.list(params.slug).catch(() => []),
    ]);
    // the Sample pane's stratify picker lists the corpus's REAL categorical
    // columns — fetched here so the pane never invents variables
    const columns = goldset.corpusId
      ? await api.corpora.columns(params.slug, goldset.corpusId)
          .then((res) => res?.columns ?? [])
          .catch(() => [])
      : [];
    return { project, goldset, construct: constructs.find((c) => c.id === goldset.constructId), columns };
  }, ({ project, goldset, construct, columns }) => {
    if (!state.pane) {
      state.pane = goldset.status === "sampling" || !goldset.sample?.length ? "sample"
        : goldset.status === "coding" ? "code"
        : goldset.status === "adjudicating" ? "adjudicate"
        : "test";
    }
    const disagreements = disagreementsOf(goldset);

    mount.append(screenHead({
      overline: `Calibration studio · ${goldset.id}`,
      // the gold set's NAME is the title — renameable in place; legacy sets
      // fall back to "Gold — <construct>"
      title: renameable.render({
        value: goldset.name ?? null,
        fallback: goldsetDisplayName(project, goldset) || "Gold standard",
        label: "Rename this gold set",
        onSave: async (name) => {
          try {
            await api.goldsets.update(params.slug, goldset.id, { name });
            goldset.name = name;
            toast.success("Gold set renamed.", { detail: name, data: false });
            refreshProject(params.slug).catch(() => {});
          } catch (err) {
            toast.error("Rename failed.", { detail: String(err.message ?? err) });
            throw err;
          }
        },
      }),
      lede: "Draw a sample and have coders label it blind. Concord reports human–human agreement first, then each instrument's agreement with the gold standard: units that were adjudicated, or that two or more coders labeled the same. An instrument that agrees with gold here can be frozen at the calibrated (●) level.",
      actions: [coderLauncherBtn(params, goldset)],
    }));

    /* -- context: whose gold this is and where its units come from -- */
    const goldCorpus = (project?.corpora ?? []).find((c) => c.id === goldset.corpusId) ?? null;
    mount.append(contextLine([
      construct
        ? { label: "gold for", text: construct.name, href: `#/p/${params.slug}/constructs/${construct.id}` }
        : { label: "gold for", text: goldset.constructId ?? "construct not recorded", faint: true },
      {
        label: "sampled from",
        text: goldCorpus ? corpusText(goldCorpus, project)
          : goldset.corpusId ? `${goldset.corpusId} — corpus no longer in this project`
          : "corpus not recorded — this gold set predates scope tracking",
        faint: !goldCorpus,
      },
    ]));

    const tabs = el("div", { class: "panetabs", role: "tablist", aria: { label: "Studio panes" } });
    const paneHost = el("div", { class: "panehost" });
    mount.append(tabs, paneHost);

    const drawPane = () => {
      clear(paneHost);
      for (const btn of tabs.querySelectorAll("[role=tab]")) {
        btn.setAttribute("aria-selected", btn.dataset.pane === state.pane ? "true" : "false");
        btn.classList.toggle("panetab--active", btn.dataset.pane === state.pane);
      }
      if (state.pane === "sample") samplePane(paneHost, params, goldset, construct, { columns, project });
      else if (state.pane === "code") codePane(paneHost, params, goldset, construct);
      else if (state.pane === "test") testPane(paneHost, params, goldset, construct);
      else adjudicatePane(paneHost, params, goldset, construct, disagreements);
    };

    const PANE_LABELS = { sample: "Sample", code: "Code", test: "Test", adjudicate: "Adjudicate" };
    for (const pane of PANES) {
      const open = (pane === "sample") || goldset.sample?.length;
      const openCount = pane === "adjudicate" && disagreements.length
        ? disagreements.filter((d) => !d.resolved && !d.excluded).length
        : null;
      tabs.append(el("button", {
        class: "panetab", role: "tab", type: "button",
        dataset: { pane },
        disabled: !open,
        "aria-selected": pane === state.pane ? "true" : "false",
        aria: { label: openCount !== null ? `${PANE_LABELS[pane]} — ${openCount} open` : null },
        onclick: () => { state.pane = pane; drawPane(); },
      },
        PANE_LABELS[pane],
        openCount !== null
          ? el("span", { class: "chip chip--signal data panetab__count", aria: { hidden: "true" } }, String(openCount))
          : null));
    }
    drawPane();

    // the set-level destructive act sits quietly under the working surface
    mount.append(deleteGoldsetFooter(params, goldset));
  }, "Opening the studio…");

  return {
    el: mount,
    destroy() {
      sprintCleanup?.();
      sprintCleanup = null;
      setFullbleed(false);
    },
  };
}

/* ================= Sample ============================================================ */

/**
 * Planning half-width on κ at 95% — the LARGE-SAMPLE approximation (Cohen
 * 1960 SE; Donner & Eliasziw 1992 for design): hw = 1.96·√(po(1−po)) /
 * (√n·(1−pe)), with po = κ·(1−pe)+pe at the planning κ. Pure and exported so
 * the numbers are probeable under node. Returns null when undefined.
 */
export function planningHalfWidth(n, pe, kappa = 0.75) {
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(pe) || pe < 0 || pe >= 1) return null;
  const po = kappa * (1 - pe) + pe;
  return (1.96 * Math.sqrt(po * (1 - po))) / (Math.sqrt(n) * (1 - pe));
}

/**
 * Chance agreement pe for the planning approximation. Label shares from the
 * construct's latest run when one carries them (pe = Σp̂ᵢ²); else binary
 * defaults to p̂ = .5 (pe = .5) and k categories to uniform shares (pe = 1/k).
 * → {pe, source: "run"|"default"|"uniform", k, runId?}
 */
export function planningPe(construct, run = null) {
  const k = Math.max(2, construct?.categories?.length ?? 2);
  const dist = run?.labelDist ?? run?.checkpoint?.labelDist ?? null;
  if (dist && typeof dist === "object") {
    const counts = Object.values(dist).map((x) => Number(x) || 0);
    const total = counts.reduce((s, x) => s + x, 0);
    if (total > 0) {
      const pe = counts.reduce((s, x) => s + (x / total) ** 2, 0);
      return { pe, source: "run", k, runId: run?.id };
    }
  }
  return k === 2 ? { pe: 0.5, source: "default", k } : { pe: 1 / k, source: "uniform", k };
}

/** The construct's most recent run (complete preferred) — for label shares. */
function latestRunForConstruct(project, constructId) {
  const instIds = new Set((project?.instruments ?? [])
    .filter((i) => i.constructId === constructId).map((i) => i.id));
  const runs = (project?.runs ?? []).filter((r) => instIds.has(r.instrumentId));
  return [...runs].reverse().find((r) => r.status === "complete") ?? runs.at(-1) ?? null;
}

function samplePane(host, params, goldset, construct, { columns = [], project = null } = {}) {
  let design = goldset.design ?? "srs";
  let n = goldset.sample?.length || 150;
  const categoricalCols = (columns ?? []).filter((c) => c.role === "categorical");
  let strata = categoricalCols[0]?.name ?? null;

  const goldCorpus = (project?.corpora ?? []).find((c) => c.id === goldset.corpusId) ?? null;
  const populationN = goldset.populationN ?? goldCorpus?.unitCount ?? null;

  /* -- why a sample is enough — the contract, with live numbers -- */
  const nOfPop = el("strong", { class: "data" });
  const paintScale = () => {
    nOfPop.textContent = populationN !== null && populationN !== undefined
      ? `${fmtCount(n)} of ${fmtCount(populationN)}`
      : `${fmtCount(n)}`;
  };
  paintScale();
  host.append(section("Why a sample is enough",
    el("p", { class: "screen__hint" },
      "You code a ", el("strong", {}, "sample"), ", not the corpus: ", nOfPop,
      " units. Because the sample is drawn with known inclusion probabilities (π), agreement statistics and corrected estimates computed from it generalize to the whole corpus.")));

  if (goldset.sample?.length) {
    // π varies by stratum under stratified designs — show the real range,
    // never just the first row's value
    const piValues = [...new Set(goldset.sample
      .map((s) => s.pi)
      .filter((x) => typeof x === "number" && Number.isFinite(x)))];
    const piChipText = piValues.length === 0 ? "π = —"
      : piValues.length === 1 ? `π = ${piValues[0]}`
      : `π = ${fmtStat(Math.min(...piValues), 3)}–${fmtStat(Math.max(...piValues), 3)} by stratum`;
    host.append(section("Current sample",
      el("p", { class: "screen__hint" },
        el("span", { class: "data" }, fmtCount(goldset.sample.length)), ` units · design: ${goldset.design} · π stored per unit `,
        el("span", { class: "chip chip--ghost data" }, piChipText)),
      el("p", { class: "faint screen__hint" }, goldset.piNote ?? "Inclusion probabilities are stored at sampling time — they are what make design-based correction (◉) possible later.")));
  }

  /* -- planning precision: what this n buys, recomputed as n changes -- */
  const run = latestRunForConstruct(project, goldset.constructId);
  const { pe, source, k, runId } = planningPe(construct, run);
  const hwText = (size) => {
    const hw = planningHalfWidth(size, pe);
    return hw === null ? "—" : `±${fmtStat(hw)}`;
  };
  const precisionLive = el("p", { class: "screen__hint", aria: { live: "polite" } });
  const paintPrecision = () => {
    clear(precisionLive).append(
      "At n = ", el("span", { class: "data" }, fmtCount(n)),
      ", a κ of .75 measured on this sample lands within ",
      el("strong", { class: "data" }, hwText(n)),
      " of the corpus truth (95%).");
  };
  paintPrecision();
  const peLine = source === "run"
    ? el("p", { class: "screen__hint faint" },
        "Label shares from run ", el("span", { class: "data" }, runId ?? "—"),
        ` set the chance-agreement term (pe = ${fmtStat(pe)}).`)
    : el("p", { class: "screen__hint faint" },
        k === 2
          ? `Planning assumes a 50/50 label split (pe = ${fmtStat(pe)}); a run's recorded label shares replace this once available.`
          : `Planning assumes uniform shares over ${k} categories (pe = ${fmtStat(pe)}); a run's recorded label shares replace this once available.`);

  host.append(section("What a given n buys",
    precisionLive,
    el("ul", { class: "planrows", role: "list" },
      ...[100, 150, 300].map((size) => el("li", { class: "planrow" },
        el("span", { class: "data planrow__n" }, `n = ${size}`),
        el("span", { class: "data planrow__hw" }, hwText(size)),
        el("span", { class: "planrow__note faint" },
          size === 150 ? "the usual gold-set size" : size === 300 ? "rare classes, many categories" : "quick anchor")))),
    peLine,
    el("p", { class: "screen__hint faint" },
      "Planning approximation (Cohen 1960 large-sample SE", cite("cohen1960"), cite("donner1992"),
      "); the Test pane reports bootstrap (percentile) CIs after coding.")));

  /* -- design — all three code a subset; π is recorded in every case -- */
  const strataExample = categoricalCols[0]?.name ?? "group";
  const designs = [
    { value: "srs", label: "Simple random", hint: "every unit equally likely — the cleanest π" },
    { value: "stratified", label: "Stratified", hint: `guarantees coverage across a metadata split (e.g., every ${strataExample} appears — n must be at least the number of groups); π varies by stratum, stored per unit`, needsColumns: true },
    { value: "uncertainty", label: "Uncertainty", hint: "oversamples units the instrument is least sure about — efficient for finding failure modes; π still recorded. Not corpus-representative: π is recorded as nominal n/N over a deterministic ranking, so corrected estimates from this design are not design-unbiased. Use it for finding hard cases, not for correction." },
  ];
  const strataSelect = el("select", {
    class: "input input--inline", "aria-label": "Stratify by — the corpus's categorical columns",
    disabled: design !== "stratified" || !categoricalCols.length,
    onchange: (e) => { strata = e.target.value; },
  }, ...(categoricalCols.length
    ? categoricalCols.map((c, i) => el("option", { value: c.name, selected: i === 0 },
        `${c.name} — categorical · ${fmtCount(c.distinct)} values`))
    : [el("option", { value: "", disabled: true, selected: true }, "no categorical columns detected")]));

  host.append(section("Design",
    el("p", { class: "screen__hint faint" }, "All three designs code a subset."),
    el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Sampling design" } },
      ...designs.map((d) => {
        const blocked = d.needsColumns && !categoricalCols.length;
        return el("label", { class: `choice${blocked ? " choice--disabled" : ""}` },
          el("input", {
            type: "radio", name: "design", value: d.value, checked: design === d.value,
            disabled: blocked,
            title: blocked ? "needs a categorical metadata column — none detected on this corpus" : null,
            onchange: () => { design = d.value; strataSelect.disabled = design !== "stratified" || !categoricalCols.length; },
          }),
          el("span", { class: "choice__text" },
            el("span", { class: "choice__label" }, d.label),
            el("span", { class: "choice__hint" }, blocked ? `${d.hint} — needs a categorical column; none detected` : d.hint)));
      })),
    el("div", { class: "controlrow" },
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "n"),
        el("input", {
          class: "input input--num", type: "number", min: 20, max: 2000, value: n,
          "aria-label": "Sample size",
          oninput: (e) => { n = Number(e.target.value); paintScale(); paintPrecision(); },
        })),
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "stratify by"), strataSelect)),
    el("p", { class: "screen__hint faint" },
      "π note: every sampled unit records its inclusion probability. DSL consumes π; the methods section reports the design verbatim."),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await draw(false);
        } catch (err) {
          e.target.disabled = false;
          // committed coding work exists — the server refuses until the user
          // confirms the discard with the real counts in front of them
          if (err?.code === "CONFIRM_REQUIRED") confirmDiscardAndResample(err);
          else toast.error("Sampling failed.", { detail: String(err.message ?? err) });
        }
      },
    }, goldset.sample?.length ? "Resample (replaces the sample)" : "Draw the sample")));

  // live response: {goldsetId, design, n, sample: [{unitId, pi}]}
  async function draw(force) {
    const res = await api.goldsets.sample(params.slug, goldset.id, {
      design, n,
      strata: design === "stratified" && strata ? { by: strata } : undefined,
      ...(force ? { force: true } : {}),
    });
    toast.success(`Sampled ${fmtCount(res.n ?? n)} units with π stored.`, { detail: `${res.design ?? design}${design === "stratified" && strata ? ` by ${strata}` : ""}`, data: true });
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  /* The 409 CONFIRM_REQUIRED sheet: state exactly what exists (the server's
     counts ride error.details) and what proceeding does; "Keep labels" cancels,
     the discard button repeats the draw with force: true. The server's
     `labels` count is per-coder handled units — labels AND can't-code marks —
     so the sheet says "units handled", not "labels". */
  function confirmDiscardAndResample(err) {
    const d = err.details?.details ?? null; // ApiError.details = envelope error; its .details = counts
    const s_ = (k) => (k === 1 ? "" : "s");
    const parts = [];
    if (d) {
      if (d.labels > 0) parts.push(`${d.labels} unit${s_(d.labels)} handled (labels and can't-codes) by ${d.coders} coder${s_(d.coders)}`);
      if (d.adjudicated > 0) parts.push(`${d.adjudicated} adjudication${s_(d.adjudicated)}`);
      if (d.excluded > 0) parts.push(`${d.excluded} exclusion${s_(d.excluded)}`);
    }
    const what = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
    const sheet = openSheet({ title: "Discard coded work and resample?", overline: "This gold set is already coded" });
    const goBtn = el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await draw(true);
          sheet.close();
        } catch (err2) {
          e.target.disabled = false;
          toast.error("Sampling failed.", { detail: String(err2.message ?? err2) });
        }
      },
    }, d?.labels > 0 ? `Discard ${d.labels} handled unit${s_(d.labels)} and resample`
      : d?.adjudicated > 0 ? `Discard ${d.adjudicated} adjudication${s_(d.adjudicated)} and resample`
        : "Discard coded work and resample");
    sheet.body.append(
      el("p", {}, what
        ? `This gold set has ${what}. Drawing a new sample discards all of it — memos and flags are wiped with the labels.`
        : String(err.message ?? "This gold set has committed coding work. Drawing a new sample discards it, including memos and flags.")),
      el("p", { class: "screen__hint" },
        "The discard is written to the project ledger. To keep the coded units instead, keep the current sample and continue in the Code pane."),
    );
    sheet.foot.append(
      el("button", { class: "btn btn--quiet", type: "button", onclick: () => sheet.close() }, "Keep labels"),
      goBtn);
  }
}

/* ================= Code — THE SPRINT ================================================== */

function codePane(host, params, goldset, construct) {
  const total = goldset.sample?.length ?? 0;
  if (!total) {
    host.append(emptyState({ title: "Nothing to code yet.", body: "Draw a sample first — the sprint starts the moment there are units to read." }));
    return;
  }

  const coders = goldset.coders ?? [];
  host.append(section("Coders",
    coders.length
      ? el("ul", { class: "coderlist", role: "list" },
          ...coders.map((c) => {
            const done = Object.keys(c.labels ?? {}).length;
            const cantCode = uncodableSetOf(c).size;
            return el("li", { class: "coderrow" },
              el("span", { class: "chip chip--gold" }, c.coderId),
              el("span", { class: "coderrow__bar", aria: { hidden: "true" } },
                el("span", { class: "coderrow__fill", style: { width: `${Math.round(((done + cantCode) / total) * 100)}%` } })),
              el("span", { class: "data" }, `${done}/${total}`),
              cantCode ? el("span", { class: "chip chip--ghost data" }, `${cantCode} can't-code`) : null,
              c.finishedAt ? el("span", { class: "chip chip--ghost" }, "complete") : null,
              c.flagged?.length ? el("span", { class: "chip chip--signal data" }, `${c.flagged.length} flagged`) : null);
          }))
      : el("p", { class: "faint" }, "No one has coded yet. The sprint reads units through the blind coder route — only unit text, the codebook, and your own progress reach this screen.")));

  const nameInput = el("input", { class: "input input--inline", placeholder: "coder id (e.g. sam)", "aria-label": "Coder id", value: continuingCoder(goldset) ?? "" });
  host.append(section("Begin",
    el("div", { class: "controlrow" },
      el("label", { class: "controlrow__item" }, el("span", { class: "overline" }, "code as"), nameInput),
      el("button", {
        class: "btn btn--primary", type: "button",
        onclick: () => {
          const coder = nameInput.value.trim();
          if (!coder) { nameInput.focus(); return; }
          startSprint(params, goldset, construct, coder);
        },
      }, "Begin the sprint")),
    el("p", { class: "screen__hint faint" },
      "Full bleed. ", kbd("j"), "/", kbd("k"), " next/previous · ", kbd("1"), "–", kbd("9"), " label · ",
      kbd("u"), " can't code · ", kbd("f"), " flag · ", kbd("m"), " memo · ", kbd("Esc"), " leave. The definition stays pinned.")));
}

function continuingCoder(goldset) {
  const open = (goldset.coders ?? []).find((c) => !c.finishedAt);
  return open?.coderId ?? null;
}

function startSprint(params, goldset, construct, coder) {
  const categories = construct?.categories ?? [];
  const total = goldset.sample.length;
  /* The sprint's unit source is the BLIND coder route (GET goldsets/:g/next):
     one fetch returns this coder's remaining queue as {id, text, pos} plus
     the codebook and own progress — no machine output, no other coder, and
     no adjudicated label is on that code path. Verdicts submit through the
     same blind /label route. */
  const queue = []; // remaining unit ids, in sample order — filled by loadQueue
  const texts = new Map(); // unitId → {id, text, pos} from the blind payload
  let codedCount = 0;
  let cantCount = 0;
  let idx = 0;
  const session = { startedAt: Date.now(), labeled: 0 };
  const history = []; // for k (previous)

  setFullbleed(true);
  const root = el("div", { class: "sprint", role: "application", aria: { label: "Coding sprint" } });
  document.body.append(root);

  const progressLine = () => `${codedCount} coded${cantCount ? ` · ${cantCount} can't-code` : ""} / ${total}`;
  const progressFill = el("span", { class: "sprint__progressfill", style: { width: `${((codedCount + cantCount) / total) * 100}%` } });
  const progressText = el("span", { class: "sprint__progresstext data", aria: { live: "polite" } }, progressLine());
  const paintProgress = () => {
    progressFill.style.width = `${((codedCount + cantCount) / total) * 100}%`;
    progressText.textContent = progressLine();
  };
  const timerEl = el("span", { class: "sprint__timer data" }, "0:00");
  const timer = setInterval(() => {
    timerEl.textContent = fmtClock((Date.now() - session.startedAt) / 1000);
  }, 1000);

  const unitHost = el("div", { class: "sprint__unit" });
  const defPanel = el("details", { class: "sprint__def", open: true },
    el("summary", { class: "sprint__defsummary" }, "Definition — pinned"),
    el("div", { class: "sprint__defbody" },
      el("p", { class: "sprint__deftext" }, construct?.definition ?? "(no definition)"),
      construct?.criteria?.include?.length
        ? el("p", { class: "sprint__defrule" }, el("strong", {}, "Include: "), construct.criteria.include.join(" · "))
        : null,
      construct?.criteria?.exclude?.length
        ? el("p", { class: "sprint__defrule" }, el("strong", {}, "Exclude: "), construct.criteria.exclude.join(" · "))
        : null,
      // the worked examples the model coder receives, word for word — human
      // coders read the same instrument (collapsed: glance, don't lean)
      construct?.examples?.length
        ? el("details", { class: "sprint__defexamples" },
            el("summary", { class: "sprint__defsummary" }, `Worked examples (${construct.examples.length})`),
            ...construct.examples.map((ex) => el("p", { class: "sprint__defrule" },
              el("strong", {}, `${ex.label}: `), ex.text)))
        : null,
      el("p", { class: "sprint__defrule" },
        kbd("u"), " marks a unit as uncodable — it is excluded from agreement statistics and queued for adjudication.")));

  const keyRow = el("div", { class: "sprint__keys", role: "toolbar", aria: { label: "Labels" } },
    ...categories.map((cat, i) =>
      el("button", {
        class: "sprint__key", type: "button",
        dataset: { value: cat.value },
        onclick: () => label(cat.value),
      },
        el("kbd", {}, String(i + 1)),
        el("span", { class: "sprint__keylabel" }, cat.label ?? cat.value))),
    el("button", {
      class: "sprint__key sprint__key--meta", type: "button",
      dataset: { value: UNCODABLE },
      title: "Mark this unit uncodable — excluded from agreement statistics, queued for adjudication",
      onclick: () => uncodable(),
    }, el("kbd", {}, "u"), el("span", { class: "sprint__keylabel" }, "can't code")),
    el("button", { class: "sprint__key sprint__key--meta", type: "button", onclick: () => flag() }, el("kbd", {}, "f"), el("span", { class: "sprint__keylabel" }, "flag")),
    el("button", { class: "sprint__key sprint__key--meta", type: "button", onclick: () => memo() }, el("kbd", {}, "m"), el("span", { class: "sprint__keylabel" }, "memo")),
  );

  root.append(
    el("header", { class: "sprint__head" },
      el("span", { class: "overline" }, `coding as ${coder} · blind`),
      el("span", { class: "sprint__progress" },
        el("span", { class: "sprint__progresstrack", aria: { hidden: "true" } }, progressFill),
        progressText),
      timerEl,
      el("button", { class: "btn btn--quiet", type: "button", onclick: () => leave() }, "Esc · leave")),
    el("div", { class: "sprint__main" }, unitHost, defPanel),
    keyRow,
  );

  let flagged = false;
  let memoText = "";

  function currentUnitId() {
    return queue[idx];
  }

  // One blind fetch fills the whole queue; drawUnit then renders locally.
  // The evidence dossier is NOT used here on purpose — it carries machine
  // labels, other coders' labels and the adjudicated label.
  async function loadQueue() {
    const view = await api.goldsets.next(params.slug, goldset.id, coder);
    cantCount = view.progress?.uncodable ?? 0;
    codedCount = Math.max(0, (view.progress?.done ?? 0) - cantCount);
    for (const u of view.remaining ?? (view.unit ? [view.unit] : [])) {
      queue.push(u.id);
      texts.set(u.id, u);
    }
    paintProgress();
    drawUnit();
  }

  function drawUnit() {
    clear(unitHost);
    flagged = false;
    memoText = "";
    const id = currentUnitId();
    if (!id) { complete(); return; }
    unitHost.append(el("p", { class: "faint data sprint__unitid" }, id));
    unitHost.append(el("blockquote", { class: "sprint__text" }, texts.get(id)?.text ?? "(unit text unavailable)"));
  }

  async function label(value) {
    const unitId = currentUnitId();
    if (!unitId) return;
    pulseKey(value);
    try {
      await api.goldsets.label(params.slug, goldset.id, { coder, unitId, label: value, memo: memoText || undefined, flag: flagged || undefined });
    } catch (err) {
      toast.error("Label did not save.", { detail: String(err.message ?? err) });
      return;
    }
    history.push(unitId);
    codedCount += 1;
    session.labeled += 1;
    paintProgress();
    queue.splice(idx, 1);
    if (idx >= queue.length) idx = Math.max(0, queue.length - 1);
    drawUnit();
  }

  /* Can't-code is a verdict, not a skip: {uncodable: true} (no label) saves,
     the unit leaves the queue, agreement will exclude it, adjudication gets it. */
  async function uncodable() {
    const unitId = currentUnitId();
    if (!unitId) return;
    pulseKey(UNCODABLE);
    try {
      await api.goldsets.label(params.slug, goldset.id, { coder, unitId, uncodable: true, memo: memoText || undefined, flag: flagged || undefined });
    } catch (err) {
      toast.error("Can't-code did not save.", { detail: String(err.message ?? err) });
      return;
    }
    history.push(unitId);
    cantCount += 1;
    session.labeled += 1;
    paintProgress();
    queue.splice(idx, 1);
    if (idx >= queue.length) idx = Math.max(0, queue.length - 1);
    drawUnit();
  }

  function pulseKey(value) {
    const btn = keyRow.querySelector(`[data-value="${CSS.escape(value)}"]`);
    btn?.classList.add("sprint__key--hit");
    setTimeout(() => btn?.classList.remove("sprint__key--hit"), 220);
  }

  function flag() {
    flagged = !flagged;
    toast.info(flagged ? "Flagged — saves with the next label." : "Flag cleared.", { duration: 1400 });
  }

  function memo() {
    const pop = openSheet({ title: "Memo", overline: currentUnitId() ?? "" });
    const ta = el("textarea", { class: "input textarea", rows: 4, "aria-label": "Memo" }, memoText);
    pop.body.append(ta);
    pop.foot.append(
      el("button", { class: "btn btn--quiet", type: "button", onclick: () => pop.close() }, "Cancel"),
      el("button", {
        class: "btn btn--primary", type: "button",
        onclick: () => { memoText = ta.value; pop.close(); toast.info("Memo holds — saves with the next label.", { duration: 1600 }); },
      }, "Keep memo"));
  }

  function move(delta) {
    if (!queue.length) return;
    idx = (idx + delta + queue.length) % queue.length;
    drawUnit();
  }

  function onKey(e) {
    if (e.target instanceof HTMLElement && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
    if (e.key === "Escape") { leave(); return; }
    if (e.key === "j") { move(1); return; }
    if (e.key === "k") { move(-1); return; }
    if (e.key === "u") { uncodable(); return; }
    if (e.key === "f") { flag(); return; }
    if (e.key === "m") { memo(); return; }
    const num = Number(e.key);
    if (num >= 1 && num <= categories.length) {
      label(categories[num - 1].value);
    }
  }
  document.addEventListener("keydown", onKey);

  function teardown() {
    clearInterval(timer);
    document.removeEventListener("keydown", onKey);
    root.remove();
    setFullbleed(false);
  }
  sprintCleanup = teardown;

  function leave() {
    teardown();
    sprintCleanup = null;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  async function complete() {
    // the quiet flourish: the rule fills, the room exhales, one line in Fraunces italic
    progressFill.style.width = "100%";
    const minutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
    clear(unitHost);
    root.querySelector(".sprint__keys")?.remove();
    defPanel.remove();
    // an empty queue means THIS coder's pass is done — the SET is complete
    // only when every unit is gold or excluded, so name the moment honestly
    let fresh = goldset;
    try { fresh = await api.goldsets.get(params.slug, goldset.id); } catch { /* stale copy is still honest about status */ }
    const codersWithLabels = (fresh.coders ?? []).filter((c) => Object.keys(c.labels ?? {}).length > 0);
    const headline = fresh.status === "complete" ? "Gold set complete" : "Your coding pass is complete";
    const done = el("div", { class: "sprint__done" },
      el("p", { class: "sprint__doneline" }, `${headline} · ${minutes} min`),
      el("p", { class: "sprint__donesub faint" },
        `${session.labeled} units this session as ${coder}. Gold set status: ${fresh.status}.`));
    if (codersWithLabels.length >= 2) {
      // agreement computes only when two coders' labels overlap
      done.append(el("button", {
        class: "btn btn--primary", type: "button",
        onclick: () => {
          teardown();
          sprintCleanup = null;
          location.hash = `#/p/${params.slug}/goldsets/${goldset.id}?pane=test`;
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        },
      }, "See the agreement"));
    } else {
      done.append(
        el("p", { class: "sprint__donesub faint" },
          "Agreement needs labels from a second coder — waiting on the second coder."),
        el("button", { class: "btn", type: "button", onclick: () => leave() }, "Back to the studio"));
    }
    unitHost.append(done);
    unitHost.querySelector("button")?.focus();
  }

  unitHost.append(el("p", { class: "faint", role: "status" }, "loading the blind queue…"));
  loadQueue().catch((err) => {
    toast.error("Could not load the coding queue.", { detail: String(err.message ?? err) });
    leave();
  });
}

function kbd(k) {
  return el("kbd", {}, k);
}

/* ================= Test ================================================================ */

// Live report (GET goldsets/:g/agreement):
//   humanAgreement: {n, coders, percent, kappa, alpha, ac1, ci?, confusion?,
//                    labels?, uncodableUnits, excludedFromAgreement}
//   perInstrument:  [{instrumentId, name, kind, level, versionHash,
//                     agreement: {n, coders, percent, kappa, alpha, ac1,
//                     perClass, confusion?, labels?}} | {…, error: {code,
//                     message}}]
//   goldLabeled:    count of gold units (adjudicated, or ≥2 coders unanimous)
function testPane(host, params, goldset, construct) {
  const wrap = el("div", {});
  host.append(wrap);
  wrap.append(el("p", { class: "faint", role: "status" }, "computing agreement…"));

  // ordinal κ is linear-weighted (the server's convention) — label it so
  const kappaLabel = construct?.type === "ordinal" ? "κw (linear)" : "κ";

  api.goldsets.agreement(params.slug, goldset.id)
    .then((report) => {
      clear(wrap);

      /* -- where κ lives for the whole construct: the Reliability home -- */
      wrap.append(el("p", { class: "screen__hint testpane__allsources" },
        el("a", { href: `#/p/${params.slug}/reliability/${encodeURIComponent(goldset.constructId)}` },
          "all sources →"),
        el("span", { class: "faint" }, " every reading of this construct — humans, gold, instruments — in one agreement matrix")));

      /* -- human first, always -- */
      const h = report.humanAgreement ?? {};
      wrap.append(el("div", { class: "humanbanner" },
        el("p", { class: "overline humanbanner__label" }, "Human–human agreement · computed before any machine comparison"),
        el("p", { class: "humanbanner__stat" },
          el("span", { class: "humanbanner__big data" }, `${kappaLabel} = ${fmtStat(h.kappa)}`),
          el("span", { class: "humanbanner__big data" }, `α = ${fmtStat(h.alpha)}`),
          el("span", { class: "data faint" }, `${fmtStat(h.percent)} raw agree · n = ${h.n ?? "—"} · ${(h.coders ?? []).join(" + ")}`)),
        h.ci
          ? el("p", { class: "data faint humanbanner__ci" },
              `α 95% CI [${fmtStat(h.ci.lo)}, ${fmtStat(h.ci.hi)}] — bootstrap (percentile)`)
          : null,
        benchmarkBand(h.alpha, h.ci),
        el("p", { class: "humanbanner__note faint" }, "Low human agreement is a construct problem before it is anyone's instrument problem.")));

      /* -- can't-code marks sit outside every statistic above -- */
      const uncodableUnits = h.uncodableUnits ?? report.uncodableUnits ?? 0;
      if (uncodableUnits > 0) {
        const dropped = h.excludedFromAgreement ?? 0;
        wrap.append(el("p", { class: "screen__hint faint" },
          el("span", { class: "data" }, fmtCount(uncodableUnits)),
          ` unit${uncodableUnits === 1 ? "" : "s"} carry a can't-code mark — those marks contribute no agreement rows; a unit drops out entirely only when fewer than two coders labeled it (`,
          el("span", { class: "data" }, fmtCount(dropped)),
          ` dropped here).`));
      }

      /* -- per-instrument columns -- */
      const cols = el("div", { class: "testcols" });
      for (const inst of report.perInstrument ?? []) {
        if (inst.error) {
          cols.append(el("section", { class: "testcol" },
            el("h3", { class: "testcol__name" }, inst.name, " ", ladderC.render({ level: inst.level, size: "sm" })),
            el("p", { class: "faint" }, "Could not test against gold: ", el("span", { class: "data" }, inst.error.message ?? inst.error.code))));
          continue;
        }
        const a = inst.agreement ?? {};
        const col = el("section", { class: "testcol" },
          el("h3", { class: "testcol__name" }, inst.name, " ", ladderC.render({ level: inst.level, size: "sm" })),
          el("p", { class: "testcol__stats data" },
            `${kappaLabel} ${fmtStat(a.kappa)} · α ${fmtStat(a.alpha)} · AC1 ${fmtStat(a.ac1)} · ${fmtStat(a.percent)} agree`),
          a.perClass?.length
            ? el("table", { class: "table table--mini" },
                el("caption", { class: "sr-only" }, `${inst.name} per-class metrics`),
                el("thead", {}, el("tr", {},
                  el("th", { scope: "col" }, "class"),
                  el("th", { scope: "col", class: "table__num data" }, "P"),
                  el("th", { scope: "col", class: "table__num data" }, "R"),
                  el("th", { scope: "col", class: "table__num data" }, "F1"))),
                el("tbody", {},
                  ...a.perClass.map((r) => el("tr", {},
                    el("td", {}, r.label),
                    el("td", { class: "table__num data" }, fmtStat(r.precision)),
                    el("td", { class: "table__num data" }, fmtStat(r.recall)),
                    el("td", { class: "table__num data" }, fmtStat(r.f1))))))
            : null,
          a.confusion
            ? confusion.render({
                labels: a.labels ?? [],
                matrix: a.confusion,
                caption: `${inst.name} vs gold — adjudicated, or ≥2 coders unanimous (n = ${a.n})`,
              })
            : null,
          // calibration evidence → the report: the confusion matrix exports as
          // publication-grade SVG (server reporting/report.js confusion block)
          a.confusion
            ? el("button", {
                class: "btn btn--quiet btn--sm testcol__addreport", type: "button",
                onclick: (e) => addConfusionToReport(params, inst, a, e.target),
              }, "Add to report →")
            : null,
        );
        cols.append(col);
      }

      /* -- the forest: every instrument's κ vs gold with its 95% CI, on one
         axis, against the human ceiling and the Landis–Koch bands. This is the
         freeze/model-choice decision surface — read it before the columns. -- */
      forestSection(wrap, report, { kappaLabel });

      wrap.append(section("Instruments against gold", cols,
        el("p", { class: "screen__hint faint" },
          "AC1 is shown alongside κ and α because it stays stable under prevalence paradoxes — skewed label shares that sharply lower κ", cite("gwet2014"), "."),
        report.goldLabeled !== undefined
          ? el("p", { class: "faint screen__hint data" }, `${fmtCount(report.goldLabeled)} gold units (adjudicated, or ≥2 coders unanimous with no can't-code mark) backed this comparison`)
          : null));
    })
    .catch((err) => {
      clear(wrap).append(emptyState({
        title: "No agreement to show yet.",
        body: String(err?.message ?? "Code the sample first — agreement computes the moment two coders overlap."),
      }));
    });
}

/* Add an instrument's confusion-vs-gold matrix to the report canvas as a chart
   block with INLINE content (labels + matrix + axes), so the server renders it
   as publication-grade SVG with the print CSS and (when present) evidence
   drill-through. The agreement confusion carries no per-cell unit ids, so the
   matrix exports without doors — the grid itself is the calibration evidence. */
async function addConfusionToReport(params, inst, agreement, btn) {
  btn.disabled = true;
  const block = {
    kind: "chart",
    title: `${inst.name} vs gold — confusion (n = ${agreement.n ?? "—"})`,
    level: inst.level ?? "exploratory",
    content: {
      title: `${inst.name} vs gold — confusion (n = ${agreement.n ?? "—"})`,
      level: inst.level ?? "exploratory",
      confusion: {
        labels: agreement.labels ?? [],
        matrix: agreement.confusion ?? [],
        rowAxis: "Gold",
        colAxis: "Machine",
      },
    },
  };
  try {
    const updated = await api.report.addBlock(params.slug, block);
    toast.success("Confusion matrix added to the report.", {
      detail: `${updated.blocks} block${updated.blocks === 1 ? "" : "s"} now — arrange and export under Reports`,
      data: true,
    });
    btn.textContent = "Added ✓";
  } catch (err) {
    btn.disabled = false;
    toast.error("Could not add to the report.", { detail: String(err.message ?? err) });
  }
}

/* The forest plot — the freeze/model-choice surface. One row per instrument:
   the point is its κ against gold (linear-weighted κw for ordinal — whatever
   the columns headline), the whisker its 95% bootstrap-percentile CI over the
   machine-vs-gold rows. The human-agreement κ rides as a gold reference row
   with a dashed guide line (its own α CI is a different statistic, so it shows
   as a ceiling point, not a whisker). The Landis–Koch bands sit behind. */
function forestSection(wrap, report, { kappaLabel }) {
  const h = report.humanAgreement ?? {};
  const instr = (report.perInstrument ?? []).filter((i) => !i.error && typeof i.agreement?.kappa === "number");
  // nothing to compare → no forest (the columns still carry the per-instrument
  // numbers and any error notes)
  if (instr.length === 0) return;

  const rows = [];
  // the human ceiling first — a reference row, gold, no whisker (its CI is on
  // α, not κ; conflating the two would mislead)
  if (typeof h.kappa === "number") {
    rows.push({
      label: "Humans (ceiling)",
      value: h.kappa,
      kind: "human",
      reference: true,
      level: "corrected",
    });
  }
  let anyCi = false;
  for (const inst of instr) {
    const a = inst.agreement;
    const ci = a.ci && typeof a.ci.lo === "number" && typeof a.ci.hi === "number" ? [a.ci.lo, a.ci.hi] : undefined;
    if (ci) anyCi = true;
    rows.push({
      label: inst.name,
      value: a.kappa,
      ci,
      level: inst.level,
      kind: "machine",
    });
  }

  const host = el("div", {});
  forest.render(host, rows, {
    stat: "κ",
    domain: [0, 1],
    format: (v) => fmtStat(v),
    caption: `${kappaLabel} against gold per instrument — point is the coefficient, whisker the 95% CI`
      + (anyCi ? " (bootstrap percentile over the machine-vs-gold rows" : " (")
      + (report.goldLabeled !== undefined ? `, n = ${fmtCount(report.goldLabeled)} gold units)` : ")")
      + `. Bands: Landis & Koch — .61 substantial, .81 almost perfect (context, never a gate). The gold ◆ is the human-agreement ceiling.`,
  });

  wrap.append(section("Forest — every instrument against gold", host));
}

/**
 * The benchmark band — context, never verdict. stat picks the convention:
 *   "α" (default) — Krippendorff's working bands: .667 tentative, .800 reliable;
 *   "κ" — Landis & Koch: .61–.80 substantial, .81–1.00 almost perfect.
 * legend: false suppresses the per-band legend (the reliability matrix
 * carries ONE cited legend for the whole surface instead). Exported — the
 * Reliability home composes the same band.
 */
export function benchmarkBand(value, ci, { stat = "α", legend = true } = {}) {
  if (value === undefined || value === null) return null;
  const kappaBands = stat === "κ";
  const lo = kappaBands ? 0.61 : 0.67;
  const hi = kappaBands ? 0.81 : 0.8;
  const loTick = kappaBands ? ".61" : ".67";
  const hiTick = kappaBands ? ".81" : ".80";
  const legendLine = kappaBands
    ? ["Landis & Koch's bands — κ .61–.80 substantial · .81–1.00 almost perfect", cite("landiskoch1977"), ". Context, never a gate."]
    : ["Krippendorff's working bands — α ≥ .800 reliable · .667–.800 tentative", cite("krippendorff2004"), ". Context, never a gate."];
  const pct = (x) => `${Math.max(0, Math.min(100, x * 100))}%`;
  return el("div", { class: "band", role: "img", aria: {
    label: kappaBands
      ? `Kappa ${fmtStat(value)} against Landis & Koch's bands: .61 substantial, .81 almost perfect.`
      : `Alpha ${fmtStat(value)} against Krippendorff's working bands: .67 tentative, .80 reliable.`,
  } },
    el("div", { class: "band__track" },
      el("span", { class: "band__zone band__zone--low", style: { left: 0, width: pct(lo) } }),
      el("span", { class: "band__zone band__zone--mid", style: { left: pct(lo), width: pct(hi - lo) } }),
      el("span", { class: "band__zone band__zone--high", style: { left: pct(hi), width: pct(1 - hi) } }),
      ci ? el("span", { class: "band__ci", style: { left: pct(ci.lo), width: pct(Math.max(0.005, ci.hi - ci.lo)) } }) : null,
      el("span", { class: "band__needle", style: { left: pct(value) } })),
    el("div", { class: "band__ticks data" },
      el("span", { style: { left: pct(lo) }, class: "band__tick" }, loTick),
      el("span", { style: { left: pct(hi) }, class: "band__tick" }, hiTick)),
    legend ? el("p", { class: "band__legend faint" }, ...legendLine) : null);
}

/* ================= Adjudicate ========================================================== */

function adjudicatePane(host, params, goldset, construct, disagreements = []) {
  const open = disagreements.filter((d) => !d.resolved && !d.excluded);
  const settled = disagreements.filter((d) => d.resolved || d.excluded);

  if (!disagreements.length) {
    host.append(emptyState({
      title: "Nothing to adjudicate.",
      body: "Split verdicts — including one coder saying can't code where another labeled — and units everyone marked can't-code queue here for the final human word: assign a label or exclude the unit from gold.",
    }));
    return;
  }

  const queueEl = el("div", { class: "adjqueue" });
  host.append(section(`Adjudication queue · ${open.length} open`, queueEl));

  const drawRow = (d) => {
    const settledNow = Boolean(d.resolved || d.excluded);
    const row = el("div", { class: `adjrow${settledNow ? " adjrow--resolved" : ""}${d.excluded ? " adjrow--excluded" : ""}` });
    const quoteHost = el("div", { class: "adjrow__quote" });
    // adjudication reads the same gold-set corpus the coders read
    api.evidence.get(params.slug, d.unitId, { corpusId: goldset.corpusId })
      .then((dossier) => {
        quoteHost.append(quotecard.render({ unit: dossier.unit, compact: true, evidence: true }));
      })
      .catch(() => quoteHost.append(el("p", { class: "data faint" }, d.unitId)));

    const finalInput = el("input", { class: "input input--inline", placeholder: "or enter a label…", "aria-label": "Final label" });
    const settle = () => {
      row.classList.add("adjrow--resolved");
      for (const b of row.querySelectorAll(".adjpick")) b.disabled = true;
      row.querySelector(".adjrow__enter")?.remove();
    };
    const decide = async (label) => {
      try {
        // live response: {status, adjudicated: <count>}
        const res = await api.goldsets.adjudicate(params.slug, goldset.id, { unitId: d.unitId, label });
        d.resolved = label;
        settle();
        row.querySelector(".adjrow__final")?.replaceChildren(
          el("span", { class: "chip chip--gold" }, `final: ${label}`));
        toast.success("Adjudicated.", { detail: `${d.unitId} → ${label}${res?.status === "complete" ? " · gold set complete" : ""}`, data: true });
      } catch (err) {
        toast.error("Adjudication failed.", { detail: String(err.message ?? err) });
      }
    };
    const exclude = async () => {
      try {
        // live response: {status, adjudicated, excluded} — the unit leaves gold permanently
        const res = await api.goldsets.adjudicate(params.slug, goldset.id, { unitId: d.unitId, exclude: true });
        d.excluded = true;
        settle();
        row.classList.add("adjrow--excluded");
        row.querySelector(".adjrow__final")?.replaceChildren(
          el("span", { class: "chip chip--ghost" }, "excluded"));
        toast.success("Excluded from gold.", { detail: `${d.unitId} counts toward no agreement statistic and no gold label${res?.status === "complete" ? " · gold set complete" : ""}`, data: true });
      } catch (err) {
        toast.error("Exclusion failed.", { detail: String(err.message ?? err) });
      }
    };

    row.append(
      quoteHost,
      el("div", { class: "adjrow__labels" },
        ...Object.entries(d.labels ?? {}).map(([coderId, label]) => label === UNCODABLE
          // a can't-code mark is not adoptable as gold — pick the other label,
          // enter one, or exclude the unit
          ? el("button", {
              class: "adjpick", type: "button", disabled: true,
              title: `${coderId} could not code this unit — adopt the other label, enter one, or exclude it from gold`,
            },
              el("span", { class: "chip chip--gold" }, coderId),
              el("span", { class: "adjpick__label" }, "can't code"))
          : el("button", {
              class: "adjpick", type: "button", title: `Adopt ${coderId}'s label`,
              onclick: () => decide(label),
              disabled: settledNow,
            },
              el("span", { class: "chip chip--gold" }, coderId),
              el("span", { class: "adjpick__label" }, label))),
        el("span", { class: "adjrow__final" },
          d.excluded
            ? el("span", { class: "chip chip--ghost" }, "excluded")
            : d.resolved ? el("span", { class: "chip chip--gold" }, `final: ${d.resolved}`) : null),
        !settledNow
          ? el("span", { class: "adjrow__enter" },
              finalInput,
              el("button", {
                class: "btn", type: "button",
                onclick: () => { if (finalInput.value.trim()) decide(finalInput.value.trim()); },
              }, "Set"),
              el("button", {
                class: "btn btn--quiet", type: "button",
                title: "Drop this unit from the gold set — it will count toward no agreement statistic and no gold label",
                onclick: () => exclude(),
              }, "Exclude from gold"))
          : null),
    );
    return row;
  };

  for (const d of [...open, ...settled]) queueEl.append(drawRow(d));

  if (construct?.categories?.length) {
    host.append(el("p", { class: "screen__hint faint" },
      "Valid labels: ", ...construct.categories.map((c) => el("span", { class: "chip" }, c.value))));
  }
}

/* ================= coder-session launcher =============================================== */

function coderLauncherBtn(params, goldset) {
  return el("button", {
    class: "btn", type: "button",
    onclick: () => openCoderSheet(params, goldset),
  }, "Coder session…");
}

function openCoderSheet(params, goldset) {
  const s = openSheet({ title: "Launch a coder session", overline: "Blind by construction" });
  const input = el("input", { class: "input input--inline", placeholder: "coder id (e.g. sam)", "aria-label": "Coder id" });
  const shareBox = el("input", { type: "checkbox" });
  const out = el("div", { class: "codersession", aria: { live: "polite" } });

  s.body.append(
    el("p", {}, "A coder session starts a second listener on this machine that serves a blind coding page for ",
      el("strong", {}, "one"), " coder on this gold set: the codebook, their next unit, and their own progress. Machine output, other coders' labels and adjudications are never on its API."),
    el("div", { class: "controlrow" },
      el("label", { class: "controlrow__item" }, el("span", { class: "overline" }, "coder"), input)),
    el("label", { class: "choice" },
      shareBox,
      el("span", { class: "choice__text" },
        el("span", { class: "choice__label" }, "Share on local network"),
        el("span", { class: "choice__hint" },
          "Anyone on your network with this link can read the sampled units and submit labels for this gold set. Localhost-only otherwise."))),
    el("div", { class: "controlrow" },
      el("button", {
        class: "btn btn--primary", type: "button",
        onclick: async (e) => {
          const coderId = input.value.trim();
          if (!coderId) { input.focus(); return; }
          const share = shareBox.checked;
          e.target.disabled = true;
          clear(out).append(el("p", { class: "faint", role: "status" }, "starting the listener…"));
          try {
            // POST goldsets/:g/coder-session → {url, lanUrl?, port} (same-
            // process restricted listener; the coder id is bound server-side,
            // share: true binds all interfaces instead of loopback)
            const session = await api.goldsets.coderSession(params.slug, goldset.id, coderId, { share });
            clear(out).append(
              el("p", { class: "screen__hint" },
                `Listener up for ${coderId}${session.existing ? " (already running)" : ""} — the coder opens this link:`),
              el("div", { class: "codeline" },
                el("code", { class: "data" }, session.url),
                copyBtn(session.url)),
              session.lanUrl
                ? el("div", {},
                    el("p", { class: "screen__hint" }, "On your network:"),
                    el("div", { class: "codeline" },
                      el("code", { class: "data" }, session.lanUrl),
                      copyBtn(session.lanUrl)))
                : null,
              el("p", { class: "screen__hint faint" },
                session.lanUrl
                  ? "Shared on your local network — anyone with the link can read the sampled units and submit labels until you end the session."
                  : share
                    ? (session.existing
                        ? "This session was started without network sharing — end it and start a new one to share."
                        : "No external IPv4 address was found on this machine — the link works only here.")
                    : "Bound to 127.0.0.1 — the link works only on this machine."),
              el("p", { class: "screen__hint faint" },
                "The page is blind: it serves the codebook, this coder's next unit, and their own progress. Other coders' labels, model labels and adjudications are not on its API."),
              el("button", {
                class: "btn btn--quiet", type: "button",
                onclick: async (ev) => {
                  ev.target.disabled = true;
                  try {
                    await api.goldsets.endCoderSession(params.slug, goldset.id, coderId);
                    toast.info("Coder session closed.", { duration: 1800 });
                    clear(out);
                  } catch (err) {
                    ev.target.disabled = false;
                    toast.error("Could not close the session.", { detail: String(err.message ?? err) });
                  }
                },
              }, "End this session"),
            );
          } catch (err) {
            // No hand-rolled fallback: a wrongly-launched second server would
            // present an UNBLINDED surface as blind. Coder sessions come only
            // from this route.
            clear(out).append(
              el("p", { class: "screen__hint" },
                "The coder listener could not start (", String(err.message ?? err), "). ",
                "Check that the server is running normally and try again — blind sessions are only ever started from here."),
            );
          }
          e.target.disabled = false;
        },
      }, "Start session")),
    out,
  );
  s.foot.append(el("button", { class: "btn", type: "button", onclick: () => s.close() }, "Done"));
}

function copyBtn(text) {
  return el("button", {
    class: "btn btn--quiet", type: "button", aria: { label: "Copy to clipboard" },
    onclick: async (e) => {
      try {
        await navigator.clipboard.writeText(text);
        e.target.textContent = "copied";
        setTimeout(() => { e.target.textContent = "copy"; }, 1500);
      } catch {
        toast.warn("Clipboard unavailable — select and copy by hand.");
      }
    },
  }, "copy");
}

/* ================= delete — the set-level destructive act =============================== */

function deleteGoldsetFooter(params, goldset) {
  return el("p", { class: "screen__hint faint" },
    el("button", {
      class: "btn btn--quiet", type: "button",
      onclick: (e) => deleteGoldset(params, goldset, e.target),
    }, "Delete this gold set"),
    " Removes it from the project — the sample, labels, and adjudications go with it; the corpus is untouched.");
}

async function deleteGoldset(params, goldset, btn) {
  btn.disabled = true;
  try {
    // first ask WITHOUT force — a fresh set deletes outright; committed
    // coding work answers 409 CONFIRM_REQUIRED with the real counts
    await api.goldsets.remove(params.slug, goldset.id);
    afterGoldsetDelete(params, goldset);
  } catch (err) {
    btn.disabled = false;
    if (err?.code === "CONFIRM_REQUIRED") confirmDeleteGoldset(params, goldset, err);
    else toast.error("Delete failed.", { detail: String(err.message ?? err) });
  }
}

function afterGoldsetDelete(params, goldset) {
  toast.success("Gold set deleted.", { detail: goldset.name || goldset.id, data: false });
  refreshProject(params.slug).catch(() => {});
  location.hash = `#/p/${params.slug}`;
}

/* The 409 CONFIRM_REQUIRED sheet for delete — same shape as the resample
   confirm above: the server's committed-work counts ride error.details, and
   the destructive button repeats the call with force. The server's `labels`
   count is per-coder handled units — labels AND can't-code marks — so the
   sheet says "units handled", not "labels". */
function confirmDeleteGoldset(params, goldset, err) {
  const d = err.details?.details ?? null; // ApiError.details = envelope error; its .details = counts
  const s_ = (k) => (k === 1 ? "" : "s");
  const parts = [];
  if (d) {
    if (d.labels > 0) parts.push(`${d.labels} unit${s_(d.labels)} handled (labels and can't-codes) by ${d.coders} coder${s_(d.coders)}`);
    if (d.adjudicated > 0) parts.push(`${d.adjudicated} adjudication${s_(d.adjudicated)}`);
    if (d.excluded > 0) parts.push(`${d.excluded} exclusion${s_(d.excluded)}`);
  }
  const what = parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  const sheet = openSheet({ title: "Delete this gold set?", overline: "This gold set is already coded" });
  sheet.body.append(
    el("p", {}, what
      ? `This gold set has ${what}. Deleting it discards all of that — labels, memos, flags, and adjudications.`
      : String(err.message ?? "This gold set has committed coding work. Deleting it discards that work.")),
    el("p", { class: "screen__hint" },
      "The deletion is written to the project ledger. The corpus and its units are untouched — only the gold standard built on them is removed."),
  );
  sheet.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => sheet.close() }, "Keep this gold set"),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.goldsets.remove(params.slug, goldset.id, { force: true });
          sheet.close();
          afterGoldsetDelete(params, goldset);
        } catch (err2) {
          e.target.disabled = false;
          toast.error("Delete failed.", { detail: String(err2.message ?? err2) });
        }
      },
    }, d?.labels > 0 ? `Discard ${d.labels} handled unit${s_(d.labels)} and delete`
      : d?.adjudicated > 0 ? `Discard ${d.adjudicated} adjudication${s_(d.adjudicated)} and delete`
        : "Delete and discard the coded work"));
}
