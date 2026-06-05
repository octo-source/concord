// Instruments — #/p/:slug/instruments[/:id] — where constructs become
// measurement. List grouped by construct with ladder marks; three editors:
//   dictionary — term chips per category, weights, negation toggle+window,
//                live highlighted preview against sample units;
//   judge      — compiled prompt with slot highlighting, workerClass, model
//                picker from the catalog, params, "Edit raw" escape hatch;
//   panel      — juror cards with family chips, live cost-per-1k, the
//                family-disjointness warning, aggregation in plain language.
// Actions: Compile (Director), Silver-tune (SSE iteration cards + sparkline),
// Stability check, Preview on 5 sample units, Freeze (→ certificate sheet).

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as toast from "../components/toast.js";
import * as glyph from "../components/glyph.js";
import * as ladderC from "../components/ladder.js";
import * as quotecard from "../components/quotecard.js";
import * as line from "../components/charts/line.js";
import { fmt, fmtStat, fmtCost, fmtCount, fmtDateTime } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, refreshProject, emptyState, openSheet, kv, kvList, markedValue } from "./_shared.js";

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

const SAMPLE_UNIT_IDS = ["u_2847f1a09c3d55b2", "u_8800c1d2e4a90b77", "u_91b3c07d2e8f4a16", "u_a8f04c6e3b92d715", "u_16d9a4e7f2c50b38"];

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const [instruments, constructs, catalog] = await Promise.all([
      api.instruments.list(params.slug),
      api.constructs.list(params.slug).catch(() => []),
      api.catalog.models().catch(() => ({})),
    ]);
    return { project, instruments, constructs, catalog };
  }, ({ instruments, constructs, catalog }) => {
    const selected = params.id ? instruments.find((i) => i.id === params.id) : null;

    mount.append(screenHead({
      overline: "Instruments",
      title: "How the constructs get measured.",
      lede: "A dictionary, a judge, or a panel — each carries its evidence mark, and each mark states what it would take to climb.",
    }));

    const split = el("div", { class: "split" });
    mount.append(split);

    /* -- list grouped by construct -- */
    const list = el("nav", { class: "split__list", aria: { label: "Instruments" } });
    if (!instruments.length) {
      list.append(emptyState({
        title: "No instruments yet.",
        body: "Instruments compile from constructs. Open a construct and ask the Director to compile, or build a dictionary by hand.",
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
      main.append(emptyState({
        title: instruments.length ? "Pick an instrument." : "Nothing to edit yet.",
        body: "Dictionaries run locally and free. Judges compile a codebook into a prompt. Panels put disjoint model families on the same bench.",
      }));
      return;
    }
    instrumentEditor(main, params, selected, constructs, catalog);
  }, "Opening the instrument bench…");
}

/* ================= editor ========================================================= */

function instrumentEditor(main, params, instRaw, constructs, catalog) {
  const inst = JSON.parse(JSON.stringify(instRaw));
  const construct = constructs.find((c) => c.id === inst.constructId);
  let dirty = false;

  const saveBtn = el("button", {
    class: "btn btn--primary", type: "button", disabled: true,
    onclick: async () => {
      saveBtn.disabled = true;
      try {
        await api.instruments.update(params.slug, inst.id, inst);
        toast.success("Instrument saved.", { detail: "edits reset the ladder to ◌ — recalibrate to climb again" });
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
          ? el("span", { class: "chip data", title: `Test–retest stability: k = ${inst.stability.k} reruns on ${inst.stability.n} units` },
              `stability α ${fmtStat(inst.stability.alpha)}`)
          : null,
        inst.frozen ? el("span", { class: "chip chip--gold" }, "frozen — edits fork") : null)),
    el("div", { class: "editor__headactions" }, saveBtn),
  ));

  if (inst.frozen) {
    main.append(el("p", { class: "screen__hint annotation annotation--still" },
      "This instrument is frozen at ● — its certificate is the contract. Any edit forks a new ◌ version with this one as parent."));
  }

  /* -- kind-specific editor -- */
  if (inst.kind === "dictionary") dictionaryEditor(main, params, inst, touch);
  else if (inst.kind === "judge") judgeEditor(main, params, inst, catalog, construct, touch);
  else if (inst.kind === "panel") panelEditor(main, params, inst, catalog, touch);

  /* -- certificate (frozen) -- */
  if (inst.certificate) {
    main.append(section("Calibration certificate", certificateCard(inst.certificate)));
  }

  /* -- silver curve, if any -- */
  if (inst.silver?.iterations?.length) {
    main.append(section("Silver-tuning history", silverCurve(inst.silver.iterations)));
  }

  /* -- actions -- */
  main.append(section("Actions", actionRow(main, params, inst)));
}

/* ================= dictionary ====================================================== */

function dictionaryEditor(main, params, inst, touch) {
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
  async function runPreview() {
    clear(previewWrap).append(el("p", { class: "faint" }, "scoring locally…"));
    const sampleIds = inst.sampleUnitIds ?? SAMPLE_UNIT_IDS;
    try {
      const [unitsRes, outputs] = await Promise.all([
        api.corpora.units(params.slug, currentCorpus(), { limit: 50 }),
        api.instruments.preview(params.slug, inst.id, { unitIds: sampleIds }).catch(() => null),
      ]);
      const units = unitsRes?.units ?? [];
      clear(previewWrap);
      for (const uid of sampleIds) {
        const unit = units.find((u) => u.id === uid);
        if (!unit) continue;
        const out = outputs?.find?.((o) => o.unitId === uid);
        const hits = out?.hits ?? localHits(unit.text, inst.payload);
        previewWrap.append(el("div", { class: "dictpreview__row" },
          quotecard.render({ unit, highlights: hits, lang: unit.lang, compact: true, evidence: true }),
          out?.scores
            ? el("p", { class: "dictpreview__scores data" },
                Object.entries(out.scores).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${fmt(v, 1)}%`).join(" · ") || "no hits")
            : null,
        ));
      }
      if (!previewWrap.children.length) previewWrap.append(el("p", { class: "faint" }, "No sample units available."));
    } catch (err) {
      clear(previewWrap).append(el("p", { class: "faint" }, "Preview unavailable: ", String(err.message ?? err)));
    }
  }
  runPreview();

  function currentCorpus() {
    const project = window.concord?.store?.get?.("project");
    return project?.corpora?.[0]?.id ?? "corp";
  }
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

  /* worker class + model + params */
  const providers = Object.keys(catalog ?? {});
  const modelSelect = el("select", { class: "input input--inline", disabled: ro, "aria-label": "Model" });
  const fillModels = (provider) => {
    clear(modelSelect);
    for (const mdl of catalog?.[provider] ?? []) {
      modelSelect.append(el("option", {
        value: mdl.id, selected: mdl.id === payload.model,
      }, `${mdl.name} · $${mdl.pricing.inUSDper1M}/${mdl.pricing.outUSDper1M} per 1M`));
    }
  };
  fillModels(payload.provider ?? providers[0]);
  modelSelect.addEventListener("change", (e) => {
    payload.model = e.target.value;
    const mdl = (catalog?.[payload.provider] ?? []).find((x) => x.id === payload.model);
    if (mdl) payload.snapshot = mdl.snapshot;
    touch();
  });

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
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "provider"),
        el("select", {
          class: "input input--inline", disabled: ro, "aria-label": "Provider",
          onchange: (e) => { payload.provider = e.target.value; fillModels(e.target.value); touch(); },
        },
          ...providers.map((p) => el("option", { value: p, selected: p === payload.provider }, p)))),
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "model"), modelSelect),
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "temperature"),
        el("input", {
          class: "input input--num", type: "number", step: "0.1", min: 0, max: 2, disabled: ro,
          value: payload.params?.temperature ?? 0, "aria-label": "Temperature",
          onchange: (e) => { payload.params = payload.params ?? {}; payload.params.temperature = Number(e.target.value); touch(); },
        })),
      el("label", { class: "controlrow__item" },
        el("span", { class: "overline" }, "max tokens"),
        el("input", {
          class: "input input--num", type: "number", step: "50", min: 50, disabled: ro,
          value: payload.params?.maxTokens ?? 400, "aria-label": "Max tokens",
          onchange: (e) => { payload.params = payload.params ?? {}; payload.params.maxTokens = Number(e.target.value); touch(); },
        })),
    ),
    el("p", { class: "screen__hint faint data" },
      `snapshot: ${payload.snapshot ?? "unpinned"} · rationale-first: ${payload.rationaleFirst !== false ? "yes" : "no"} · schema: ${payload.schema?.type ?? "—"}${payload.schema?.options ? ` (${payload.schema.options.join(", ")})` : ""}`)));
}

/* ================= panel ============================================================ */

function panelEditor(main, params, inst, catalog, touch) {
  const payload = inst.payload ?? (inst.payload = { jurors: [], aggregation: "majority" });
  const ro = inst.frozen;
  const allModels = Object.entries(catalog ?? {}).flatMap(([provider, models]) =>
    (models ?? []).map((m) => ({ ...m, provider })));

  const warnBox = el("div", { class: "panelwarn", aria: { live: "polite" } });
  const costLine = el("p", { class: "panelcost data", aria: { live: "polite" } });
  const jurorWrap = el("div", { class: "jurors" });

  const redraw = () => {
    clear(jurorWrap);
    payload.jurors.forEach((j, i) => {
      jurorWrap.append(el("div", { class: "juror" },
        el("div", { class: "juror__head" },
          el("span", { class: "juror__name data" }, j.model),
          el("span", { class: "chip" }, j.family ?? familyOf(j)),
          el("span", { class: "chip chip--ghost" }, j.provider)),
        el("p", { class: "juror__meta faint data" }, j.snapshot ?? "unpinned"),
        !ro ? el("button", {
          class: "btn btn--quiet juror__remove", type: "button", aria: { label: `Remove juror ${j.model}` },
          onclick: () => { payload.jurors.splice(i, 1); touch(); redraw(); },
        }, "remove") : null,
      ));
    });
    if (!ro) {
      const select = el("select", { class: "input", "aria-label": "Add juror from catalog" },
        el("option", { value: "" }, "+ add juror from the catalog…"),
        ...allModels.map((m, idx) =>
          el("option", { value: String(idx) }, `${m.provider} · ${m.name} (${m.family})`)));
      select.addEventListener("change", () => {
        const m = allModels[Number(select.value)];
        if (!m) return;
        payload.jurors.push({
          provider: m.provider, model: m.id, snapshot: m.snapshot, family: m.family,
          params: { temperature: 0, maxTokens: 400 }, workerClass: m.class ?? "small",
        });
        touch(); redraw();
      });
      jurorWrap.append(el("div", { class: "juror juror--add" }, select));
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
  };

  redraw();
  main.append(section("Panel composition", jurorWrap, warnBox, costLine));

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

function certificateCard(cert) {
  const a = cert.agreement ?? {};
  return el("div", { class: "certificate" },
    el("p", { class: "certificate__seal", aria: { hidden: "true" } }, "●"),
    kvList(
      kv("Frozen", fmtDateTime(cert.frozenAt)),
      kv("Against gold", el("span", { class: "data" }, cert.goldsetId ?? "—")),
      kv("Agreement", markedValue(`κ = ${fmtStat(a.kappa)} · α = ${fmtStat(a.alpha)} · AC1 = ${fmtStat(a.ac1)}`, "calibrated"),
        a.ci ? el("span", { class: "faint data" }, ` 95% CI [${fmtStat(a.ci.lo)}, ${fmtStat(a.ci.hi)}] · n = ${a.n}`) : null),
      kv("Human–human", cert.humanAgreement
        ? el("span", { class: "data" }, `κ = ${fmtStat(cert.humanAgreement.kappa)} · α = ${fmtStat(cert.humanAgreement.alpha)} (n = ${cert.humanAgreement.n})`)
        : "—"),
      kv("Version", el("span", { class: "data" }, String(cert.versionHash ?? "").slice(0, 16))),
      kv("Model pinned", cert.modelPinned ? "yes — snapshot recorded" : "no — stated plainly in methods"),
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

function actionRow(main, params, inst) {
  const out = el("div", { class: "actionout" });
  const row = el("div", { class: "actionrow" });

  const compile = el("button", {
    class: "btn", type: "button",
    onclick: async () => {
      compile.disabled = true;
      clear(out).append(el("p", { class: "faint", role: "status" }, `${glyph.GLYPH} the Director is compiling…`));
      try {
        const next = await api.instruments.compile(params.slug, inst.id);
        toast.success(`Compiled v${next.version}.`, { detail: "Director-authored — the glyph stays until you touch it", data: false });
        await refreshProject(params.slug).catch(() => {});
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      } catch (err) {
        compile.disabled = false;
        clear(out);
        toast.error("Compile failed.", { detail: String(err.message ?? err) });
      }
    },
  }, `${glyph.GLYPH} Compile`);

  const silver = el("button", {
    class: "btn", type: "button",
    onclick: () => {
      silver.disabled = true;
      clear(out).append(el("p", { class: "overline" }, "Silver-tuning — Director labels a sample, the worker iterates"));
      const list = el("ol", { class: "itercards", role: "list", aria: { live: "polite" } });
      out.append(list);
      const pts = [];
      let chart = null;
      api.instruments.silverTune(params.slug, inst.id, {}, {
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
          silver.disabled = false;
          out.append(el("p", { class: "screen__hint" },
            `Plateaued at α = ${fmtStat(final?.agreement ?? pts[pts.length - 1]?.y)} on silver. `,
            el("span", { class: "faint" }, final?.note ?? "Human gold supersedes silver.")));
          refreshProject(params.slug).catch(() => {});
        },
        onError(err) {
          silver.disabled = false;
          out.append(el("p", { class: "faint" }, "Tuning stream failed: ", String(err.message ?? err)));
        },
      });
    },
  }, "Silver-tune");

  const stability = el("button", {
    class: "btn", type: "button",
    onclick: async () => {
      stability.disabled = true;
      clear(out).append(el("p", { class: "faint", role: "status" }, "re-running k = 3 on a 100-unit subsample…"));
      try {
        const res = await api.instruments.stability(params.slug, inst.id);
        clear(out).append(el("p", { class: "screen__hint" },
          markedValue(`test–retest α = ${fmtStat(res.alpha)} (k = ${res.k}, n = ${res.n})`, res.pass ? "stabilized" : "exploratory"),
          " ",
          res.pass ? el("span", {}, "— stable with itself. ", el("strong", {}, "◑ earned.")) : el("span", {}, "— below the .80 bar; the instrument wobbles on rereads.")));
        if (res.pass) toast.success("Stability passed — instrument is ◑.", { detail: `α = ${fmtStat(res.alpha)}`, data: true });
        await refreshProject(params.slug).catch(() => {});
      } catch (err) {
        toast.error("Stability check failed.", { detail: String(err.message ?? err) });
      }
      stability.disabled = false;
    },
  }, "Stability check");

  const preview = el("button", {
    class: "btn", type: "button",
    onclick: async () => {
      preview.disabled = true;
      clear(out).append(el("p", { class: "faint", role: "status" }, "previewing on 5 sample units (nothing persists)…"));
      try {
        const ids = inst.sampleUnitIds ?? SAMPLE_UNIT_IDS;
        const outputs = await api.instruments.preview(params.slug, inst.id, { unitIds: ids });
        clear(out).append(el("table", { class: "table table--mini" },
          el("caption", { class: "sr-only" }, "Preview outputs"),
          el("thead", {}, el("tr", {},
            el("th", { scope: "col" }, "unit"), el("th", { scope: "col" }, "label"),
            el("th", { scope: "col", class: "table__num data" }, "conf"), el("th", { scope: "col" }, "rationale"))),
          el("tbody", {},
            ...outputs.map((o) => el("tr", {},
              el("td", {}, el("button", { class: "refchip data evidence-door", type: "button", dataset: { evidence: o.unitId } }, String(o.unitId).slice(0, 8) + "…")),
              el("td", {}, el("span", { class: "chip chip--machine" }, String(o.label))),
              el("td", { class: "table__num data" }, o.confidence !== undefined ? fmtStat(o.confidence) : "—"),
              el("td", { class: "previewrationale" }, o.rationale ?? "—"))))));
      } catch (err) {
        clear(out).append(el("p", { class: "faint" }, "Preview failed: ", String(err.message ?? err)));
      }
      preview.disabled = false;
    },
  }, "Preview on 5 units");

  const freeze = el("button", {
    class: "btn", type: "button", disabled: inst.frozen,
    onclick: () => freezeSheet(params, inst),
  }, inst.frozen ? "Frozen ●" : "Freeze → ●");

  row.append(compile, silver, stability, preview, freeze);
  return el("div", {}, row, out);
}

function freezeSheet(params, inst) {
  const s = openSheet({ title: "Freeze this instrument", overline: "Calibration certificate" });
  let goldsetId = null;
  const select = el("select", { class: "input", "aria-label": "Gold set" }, el("option", { value: "" }, "choose a gold set…"));
  api.goldsets.list(params.slug).then((sets) => {
    for (const g of sets) {
      select.append(el("option", { value: g.id }, `${g.name ?? g.id} (${g.status})`));
    }
  }).catch(() => {});
  select.addEventListener("change", () => { goldsetId = select.value || null; });

  s.body.append(
    el("p", {}, "Freezing stamps the version hash into a calibration certificate with its agreement-vs-gold numbers. The instrument becomes read-only; any future edit forks a new ◌ version."),
    el("label", { class: "field" }, el("span", { class: "field__label overline" }, "Certify against"), select),
  );
  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        if (!goldsetId) { select.focus(); return; }
        e.target.disabled = true;
        try {
          const cert = await api.instruments.freeze(params.slug, inst.id, { goldsetId });
          s.close();
          toast.success("Instrument frozen at ●.", { detail: `κ = ${fmtStat(cert?.agreement?.kappa)} vs gold · certificate written`, data: true });
          await refreshProject(params.slug).catch(() => {});
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (err) {
          e.target.disabled = false;
          toast.error("Freeze failed.", { detail: String(err.message ?? err) });
        }
      },
    }, "Freeze"),
  );
}
