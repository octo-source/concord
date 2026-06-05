// Calibration Studio — #/p/:slug/goldsets/:gid — where machine reading earns
// the right to be believed. Four panes follow the goldset's life:
//   Sample     design picker (SRS/stratified/uncertainty), n with guidance, π note
//   Code       THE SPRINT — full-bleed, large-type serif unit, pinned definition,
//              j/k travel, number keys label, f flags, m memos, progress + timer,
//              and one quiet typographic completion moment. No confetti.
//   Test       human–human κ/α FIRST (with CI and benchmark band), then
//              per-instrument columns with clickable confusion heat-tables,
//              iteration log with κ sparkline and the McNemar honesty note.
//   Adjudicate disagreement queue, side-by-side coder labels, pick-or-enter.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as toast from "../components/toast.js";
import * as confusion from "../components/confusion.js";
import * as quotecard from "../components/quotecard.js";
import * as ladderC from "../components/ladder.js";
import * as line from "../components/charts/line.js";
import { fmtStat, fmtCount, fmtClock } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, emptyState, openSheet, setFullbleed, markedValue } from "./_shared.js";

export const route = "p/:slug/goldsets/:gid";
export const title = "Calibration Studio";

const PANES = ["sample", "code", "test", "adjudicate"];

let sprintCleanup = null;

export function render(mount, params, query) {
  const state = { pane: query.pane ?? null };
  asyncMount(mount, async () => {
    await ensureProject(params.slug);
    const [goldset, constructs] = await Promise.all([
      api.goldsets.get(params.slug, params.gid),
      api.constructs.list(params.slug).catch(() => []),
    ]);
    return { goldset, construct: constructs.find((c) => c.id === goldset.constructId) };
  }, ({ goldset, construct }) => {
    if (!state.pane) {
      state.pane = goldset.status === "sampling" || !goldset.sample?.length ? "sample"
        : goldset.status === "coding" ? "code"
        : goldset.status === "adjudicating" ? "adjudicate"
        : "test";
    }

    mount.append(screenHead({
      overline: `Calibration studio · ${goldset.name ?? goldset.id}`,
      title: construct ? `Gold for “${construct.name}”` : "Gold standard",
      lede: "Human judgment is the standard machines are measured against — never the other way around.",
      actions: [coderLauncherBtn(params, goldset)],
    }));

    const tabs = el("div", { class: "panetabs", role: "tablist", aria: { label: "Studio panes" } });
    const paneHost = el("div", { class: "panehost" });
    mount.append(tabs, paneHost);

    const drawPane = () => {
      clear(paneHost);
      for (const btn of tabs.querySelectorAll("[role=tab]")) {
        btn.setAttribute("aria-selected", btn.dataset.pane === state.pane ? "true" : "false");
        btn.classList.toggle("panetab--active", btn.dataset.pane === state.pane);
      }
      if (state.pane === "sample") samplePane(paneHost, params, goldset, construct);
      else if (state.pane === "code") codePane(paneHost, params, goldset, construct);
      else if (state.pane === "test") testPane(paneHost, params, goldset);
      else adjudicatePane(paneHost, params, goldset, construct);
    };

    const PANE_LABELS = { sample: "Sample", code: "Code", test: "Test", adjudicate: "Adjudicate" };
    for (const pane of PANES) {
      const open = (pane === "sample") || goldset.sample?.length;
      const openCount = pane === "adjudicate" && goldset.disagreements
        ? goldset.disagreements.filter((d) => !d.resolved).length
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

function samplePane(host, params, goldset, construct) {
  let design = goldset.design ?? "srs";
  let n = goldset.sample?.length || 150;
  let strata = "dept";

  if (goldset.sample?.length) {
    host.append(section("Current sample",
      el("p", { class: "screen__hint" },
        el("span", { class: "data" }, fmtCount(goldset.sample.length)), ` units · design: ${goldset.design} · π stored per unit `,
        el("span", { class: "chip chip--ghost data" }, `π = ${goldset.sample[0]?.pi ?? "—"}`)),
      el("p", { class: "faint screen__hint" }, goldset.piNote ?? "Inclusion probabilities are stored at sampling time — they are what make design-based correction (◉) possible later.")));
  }

  const guidance = el("p", { class: "screen__hint" },
    "Guidance: ~100–200 units for a binary construct at moderate prevalence; more for many categories or rare classes. The price is stated where the level-up is offered, never demanded.");

  const designs = [
    { value: "srs", label: "Simple random", hint: "every unit equally likely — the default, and the cleanest π" },
    { value: "stratified", label: "Stratified", hint: "guarantee coverage across a metadata split (π varies by stratum, stored per unit)" },
    { value: "uncertainty", label: "Uncertainty", hint: "oversample where the current instrument is least sure — efficient, π still recorded" },
  ];
  const strataSelect = el("select", {
    class: "input input--inline", "aria-label": "Stratify by", disabled: design !== "stratified",
    onchange: (e) => { strata = e.target.value; },
  }, ...["dept", "region", "satisfaction", "tenure_years"].map((k) => el("option", { value: k }, k)));

  host.append(section("Design",
    el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Sampling design" } },
      ...designs.map((d) =>
        el("label", { class: "choice" },
          el("input", {
            type: "radio", name: "design", value: d.value, checked: design === d.value,
            onchange: () => { design = d.value; strataSelect.disabled = design !== "stratified"; },
          }),
          el("span", { class: "choice__text" },
            el("span", { class: "choice__label" }, d.label),
            el("span", { class: "choice__hint" }, d.hint))))),
    el("div", { class: "controlrow" },
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "n"),
        el("input", {
          class: "input input--num", type: "number", min: 20, max: 2000, value: n,
          "aria-label": "Sample size",
          onchange: (e) => { n = Number(e.target.value); },
        })),
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "stratify by"), strataSelect)),
    guidance,
    el("p", { class: "screen__hint faint" },
      "π note: every sampled unit records its inclusion probability. DSL consumes π; the methods section reports the design verbatim."),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const sample = await api.goldsets.sample(params.slug, goldset.id, { design, n, strata: design === "stratified" ? { by: strata } : undefined });
          toast.success(`Sampled ${fmtCount(sample.length ?? n)} units with π stored.`, { detail: `${design}${design === "stratified" ? ` by ${strata}` : ""}`, data: true });
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (err) {
          e.target.disabled = false;
          toast.error("Sampling failed.", { detail: String(err.message ?? err) });
        }
      },
    }, goldset.sample?.length ? "Resample (replaces the sample)" : "Draw the sample")));
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
            return el("li", { class: "coderrow" },
              el("span", { class: "chip chip--gold" }, c.coderId),
              el("span", { class: "coderrow__bar", aria: { hidden: "true" } },
                el("span", { class: "coderrow__fill", style: { width: `${Math.round((done / total) * 100)}%` } })),
              el("span", { class: "data" }, `${done}/${total}`),
              c.finishedAt ? el("span", { class: "chip chip--ghost" }, "complete") : null,
              c.flagged?.length ? el("span", { class: "chip chip--signal data" }, `${c.flagged.length} flagged`) : null);
          }))
      : el("p", { class: "faint" }, "No one has coded yet. Blindness is enforced by the server role, not by promise.")));

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
      kbd("f"), " flag · ", kbd("m"), " memo · ", kbd("Esc"), " leave. The definition stays pinned.")));
}

function continuingCoder(goldset) {
  const open = (goldset.coders ?? []).find((c) => !c.finishedAt);
  return open?.coderId ?? null;
}

function startSprint(params, goldset, construct, coder) {
  const categories = construct?.categories ?? [];
  const rec = (goldset.coders ?? []).find((c) => c.coderId === coder);
  const already = rec ? Object.keys(rec.labels ?? {}) : [];
  const queue = goldset.sample.map((s) => s.unitId).filter((id) => !already.includes(id));
  const total = goldset.sample.length;
  let doneCount = total - queue.length;
  let idx = 0;
  const session = { startedAt: Date.now(), labeled: 0 };
  const history = []; // for k (previous)

  setFullbleed(true);
  const root = el("div", { class: "sprint", role: "application", aria: { label: "Coding sprint" } });
  document.body.append(root);

  const progressFill = el("span", { class: "sprint__progressfill", style: { width: `${(doneCount / total) * 100}%` } });
  const progressText = el("span", { class: "sprint__progresstext data", aria: { live: "polite" } }, `${doneCount} / ${total}`);
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
        : null));

  const keyRow = el("div", { class: "sprint__keys", role: "toolbar", aria: { label: "Labels" } },
    ...categories.map((cat, i) =>
      el("button", {
        class: "sprint__key", type: "button",
        dataset: { value: cat.value },
        onclick: () => label(cat.value),
      },
        el("kbd", {}, String(i + 1)),
        el("span", { class: "sprint__keylabel" }, cat.label ?? cat.value))),
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

  async function drawUnit() {
    clear(unitHost);
    flagged = false;
    memoText = "";
    const id = currentUnitId();
    if (!id) { complete(); return; }
    unitHost.append(el("p", { class: "faint data sprint__unitid" }, id));
    try {
      const dossier = await api.evidence.get(params.slug, id);
      const u = dossier?.unit ?? { id, text: "(unit unavailable)" };
      // blind: only the text and position — no machine readings, no meta that biases
      unitHost.append(el("blockquote", { class: "sprint__text", lang: dossier?.lang || undefined }, u.text));
    } catch {
      unitHost.append(el("blockquote", { class: "sprint__text" }, "(unit text unavailable)"));
    }
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
    doneCount += 1;
    session.labeled += 1;
    progressFill.style.width = `${(doneCount / total) * 100}%`;
    progressText.textContent = `${doneCount} / ${total}`;
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

  function complete() {
    // the quiet flourish: the rule fills, the room exhales, one line in Fraunces italic
    progressFill.style.width = "100%";
    const minutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
    clear(unitHost);
    root.querySelector(".sprint__keys")?.remove();
    defPanel.remove();
    unitHost.append(el("div", { class: "sprint__done" },
      el("p", { class: "sprint__doneline" }, `Gold set complete · ${minutes} min`),
      el("p", { class: "sprint__donesub faint" }, `${session.labeled} units this session as ${coder}.`),
      el("button", {
        class: "btn btn--primary", type: "button",
        onclick: () => {
          teardown();
          sprintCleanup = null;
          location.hash = `#/p/${params.slug}/goldsets/${goldset.id}?pane=test`;
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        },
      }, "See the agreement")));
    unitHost.querySelector("button")?.focus();
  }

  drawUnit();
}

function kbd(k) {
  return el("kbd", {}, k);
}

/* ================= Test ================================================================ */

function testPane(host, params, goldset) {
  const wrap = el("div", {});
  host.append(wrap);
  wrap.append(el("p", { class: "faint", role: "status" }, "computing agreement…"));

  api.goldsets.agreement(params.slug, goldset.id)
    .then((report) => {
      clear(wrap);

      /* -- human first, always -- */
      const h = report.humanAgreement ?? {};
      wrap.append(el("div", { class: "humanbanner" },
        el("p", { class: "overline humanbanner__label" }, "Human–human agreement · computed before any machine comparison"),
        el("p", { class: "humanbanner__stat" },
          el("span", { class: "humanbanner__big data" }, `κ = ${fmtStat(h.kappa)}`),
          el("span", { class: "humanbanner__big data" }, `α = ${fmtStat(h.alpha)}`),
          h.ci ? el("span", { class: "data faint" }, `95% CI [${fmtStat(h.ci.lo)}, ${fmtStat(h.ci.hi)}] · n = ${h.n}`) : null),
        benchmarkBand(h.alpha, h.ci),
        el("p", { class: "humanbanner__note faint" }, h.note ?? "Low human agreement is a construct problem before it is anyone's instrument problem.")));

      /* -- per-instrument columns -- */
      const cols = el("div", { class: "testcols" });
      for (const inst of report.perInstrument ?? []) {
        const col = el("section", { class: "testcol" },
          el("h3", { class: "testcol__name" }, inst.name, " ", ladderC.render({ level: inst.level, size: "sm" })),
          el("p", { class: "testcol__stats data" },
            `κ ${fmtStat(inst.kappa)} · α ${fmtStat(inst.alpha)} · AC1 ${fmtStat(inst.ac1)} · ${fmtStat(inst.percent)} agree`,
            inst.ci ? el("span", { class: "faint" }, ` · CI [${fmtStat(inst.ci.lo)}, ${fmtStat(inst.ci.hi)}]`) : null),
          inst.perClass?.length
            ? el("table", { class: "table table--mini" },
                el("caption", { class: "sr-only" }, `${inst.name} per-class metrics`),
                el("thead", {}, el("tr", {},
                  el("th", { scope: "col" }, "class"),
                  el("th", { scope: "col", class: "table__num data" }, "P"),
                  el("th", { scope: "col", class: "table__num data" }, "R"),
                  el("th", { scope: "col", class: "table__num data" }, "F1"))),
                el("tbody", {},
                  ...inst.perClass.map((r) => el("tr", {},
                    el("td", {}, r.label),
                    el("td", { class: "table__num data" }, fmtStat(r.precision)),
                    el("td", { class: "table__num data" }, fmtStat(r.recall)),
                    el("td", { class: "table__num data" }, fmtStat(r.f1))))))
            : null,
          inst.confusion
            ? confusion.render({
                labels: report.labels ?? [],
                matrix: inst.confusion,
                evidence: inst.confusionEvidence ?? null,
                caption: `${inst.name} vs adjudicated gold (n = ${inst.n})`,
              })
            : null,
        );
        cols.append(col);
      }
      wrap.append(section("Instruments against gold", cols));

      /* -- iteration log + McNemar -- */
      if (report.iterationLog?.length) {
        const sparkWrap = el("div", { class: "iterspark" });
        line.render(sparkWrap, [{
          label: "κ vs gold", emphasis: true,
          points: report.iterationLog.map((it, i) => ({ x: i + 1, y: it.kappa })),
        }], { caption: "Instrument iterations against gold", formatX: (x) => report.iterationLog[x - 1]?.version ?? `v${x}`, formatY: (v) => fmtStat(v), dots: true, height: 140 });
        wrap.append(section("Iteration log",
          sparkWrap,
          el("ol", { class: "iterlist", role: "list" },
            ...report.iterationLog.map((it) =>
              el("li", { class: "iterlist__row" },
                el("span", { class: "data iterlist__n" }, it.version),
                el("span", { class: "data iterlist__a" }, `κ ${fmtStat(it.kappa)}`),
                el("span", { class: "iterlist__note faint" }, it.note ?? "")))),
          report.mcnemar
            ? el("p", { class: "annotation annotation--still" },
                el("span", { class: "chip chip--ghost" }, "McNemar"),
                " ", report.mcnemar.note ?? `b=${report.mcnemar.b}, c=${report.mcnemar.c}, p=${report.mcnemar.pExact}`)
            : null));
      }
    })
    .catch((err) => {
      clear(wrap).append(emptyState({
        title: "No agreement to show yet.",
        body: String(err?.message ?? "Code the sample first — agreement computes the moment two coders overlap."),
      }));
    });
}

/** The benchmark band — context, never verdict. */
function benchmarkBand(alpha, ci) {
  if (alpha === undefined || alpha === null) return null;
  const pct = (x) => `${Math.max(0, Math.min(100, x * 100))}%`;
  return el("div", { class: "band", role: "img", aria: { label: `Alpha ${fmtStat(alpha)} against Krippendorff's working bands: .67 tentative, .80 reliable.` } },
    el("div", { class: "band__track" },
      el("span", { class: "band__zone band__zone--low", style: { left: 0, width: pct(0.67) } }),
      el("span", { class: "band__zone band__zone--mid", style: { left: pct(0.67), width: pct(0.13) } }),
      el("span", { class: "band__zone band__zone--high", style: { left: pct(0.8), width: pct(0.2) } }),
      ci ? el("span", { class: "band__ci", style: { left: pct(ci.lo), width: pct(Math.max(0.005, ci.hi - ci.lo)) } }) : null,
      el("span", { class: "band__needle", style: { left: pct(alpha) } })),
    el("div", { class: "band__ticks data" },
      el("span", { style: { left: pct(0.67) }, class: "band__tick" }, ".67"),
      el("span", { style: { left: pct(0.8) }, class: "band__tick" }, ".80")),
    el("p", { class: "band__legend faint" }, "Krippendorff's working bands — α ≥ .80 reliable · .67–.80 tentative. Context, never a gate."));
}

/* ================= Adjudicate ========================================================== */

function adjudicatePane(host, params, goldset, construct) {
  const open = (goldset.disagreements ?? []).filter((d) => !d.resolved);
  const resolved = (goldset.disagreements ?? []).filter((d) => d.resolved);

  if (!goldset.disagreements?.length) {
    host.append(emptyState({
      title: "No disagreements.",
      body: "When two coders split on a unit, it queues here for the final human word.",
    }));
    return;
  }

  const queueEl = el("div", { class: "adjqueue" });
  host.append(section(`Disagreement queue · ${open.length} open`, queueEl));

  const drawRow = (d) => {
    const row = el("div", { class: `adjrow${d.resolved ? " adjrow--resolved" : ""}` });
    const quoteHost = el("div", { class: "adjrow__quote" });
    api.evidence.get(params.slug, d.unitId)
      .then((dossier) => {
        quoteHost.append(quotecard.render({ unit: dossier.unit, lang: dossier.lang, compact: true, evidence: true }));
      })
      .catch(() => quoteHost.append(el("p", { class: "data faint" }, d.unitId)));

    const finalInput = el("input", { class: "input input--inline", placeholder: "or enter a label…", "aria-label": "Final label" });
    const decide = async (label) => {
      try {
        const res = await api.goldsets.adjudicate(params.slug, goldset.id, { unitId: d.unitId, label });
        d.resolved = label;
        row.classList.add("adjrow--resolved");
        row.querySelector(".adjrow__final")?.replaceChildren(
          el("span", { class: "chip chip--gold" }, `final: ${label}`));
        toast.success("Adjudicated.", { detail: `${d.unitId} → ${label}${res?.open === 0 ? " · queue clear" : ""}`, data: true });
      } catch (err) {
        toast.error("Adjudication failed.", { detail: String(err.message ?? err) });
      }
    };

    row.append(
      quoteHost,
      el("div", { class: "adjrow__labels" },
        ...Object.entries(d.labels ?? {}).map(([coderId, label]) =>
          el("button", {
            class: "adjpick", type: "button", title: `Adopt ${coderId}'s label`,
            onclick: () => decide(label),
            disabled: Boolean(d.resolved),
          },
            el("span", { class: "chip chip--gold" }, coderId),
            el("span", { class: "adjpick__label" }, label))),
        el("span", { class: "adjrow__final" },
          d.resolved ? el("span", { class: "chip chip--gold" }, `final: ${d.resolved}`) : null),
        !d.resolved
          ? el("span", { class: "adjrow__enter" },
              finalInput,
              el("button", {
                class: "btn", type: "button",
                onclick: () => { if (finalInput.value.trim()) decide(finalInput.value.trim()); },
              }, "Set"))
          : null),
    );
    return row;
  };

  for (const d of [...open, ...resolved]) queueEl.append(drawRow(d));

  if (construct?.categories?.length) {
    host.append(el("p", { class: "screen__hint faint" },
      "Valid labels: ", ...construct.categories.map((c) => el("span", { class: "chip" }, c.value))));
  }
}

/* ================= coder-session launcher =============================================== */

function coderLauncherBtn(params, goldset) {
  return el("button", {
    class: "btn", type: "button",
    onclick: async () => {
      const s = openSheet({ title: "Launch a coder session", overline: "Blind by construction" });
      s.body.append(el("p", { class: "faint", role: "status" }, "preparing…"));
      // No coder-session route exists in api.js yet (flagged in the build report);
      // the server's --coder launch profile is the contract we surface here.
      let info = null;
      try {
        const res = await fetch("fixtures/goldsets.json");
        if (res.ok) info = (await res.json()).coderSession;
      } catch { /* offline is fine */ }
      const url = info?.url ?? `${location.origin}/?coder=${goldset.id}:<coderId>`;
      const cmd = info?.command ?? `start.bat --coder ${goldset.id}:<coderId>`;
      clear(s.body).append(
        el("p", {}, "A coder session serves ", el("strong", {}, "only"), " the coding screen. Machine labels and other coders' labels are stripped server-side — blindness is enforced by the role, not by convention."),
        el("div", { class: "codeline" },
          el("code", { class: "data" }, cmd),
          copyBtn(cmd)),
        el("div", { class: "codeline" },
          el("code", { class: "data" }, url),
          copyBtn(url)),
        el("p", { class: "screen__hint faint" }, info?.note ?? "Replace <coderId> with the coder's name."),
      );
      s.foot.append(el("button", { class: "btn", type: "button", onclick: () => s.close() }, "Done"));
    },
  }, "Coder session…");
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
