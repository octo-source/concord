// Instant Read — #/p/:slug/corpus/:cid/instant — the first look, computed
// locally in under a second: length histogram, language mix, top distinctive
// terms in a two-column mono list, a VADER sentiment sketch, and metadata
// marginals as small multiples. The one CTA leads to the Corpus Brief.
//
// Live contract (GET corpora/:c/instantread):
//   local: true, unitCount,
//   lengthHist:      {bins: [{lo, hi, n, unitIds}], unit: "words"}
//   langMix:         {en, es, other} — shares that sum to ~1
//   langUnits:       {en: {n, unitIds}, es: …, other: …} — evidence per language
//   topTerms:        [{term, count}] — tf·idf-ranked, stopworded
//   sentimentSketch: {lexicon: "VADER", positive, negative, neutral, meanValence}
//   sentimentUnits:  {positive: {n, unitIds}, neutral: …, negative: …}
//   metaMarginals:   [{column, values: [{value, n, unitIds}]}]
//   briefEstimate:   {usd, etaMin} | null — the CTA's price tag (design §6.1:
//                    the level-up affordance always states its price); null
//                    only when no Director slot is configured
//   computedAt:      ISO timestamp (also the cache marker)
//
// unitIds lists cap at 100 server-side; the n beside each list is the TRUE
// count, passed to the chart as evidenceTotal so the inspector can say
// "first 100 of N". Bars whose datum carries `evidence` are doors into the
// evidence inspector (components/charts/bar.js).

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as bar from "../components/charts/bar.js";
import * as smallmultiples from "../components/charts/smallmultiples.js";
import * as scopechip from "../components/scopechip.js";
import * as toast from "../components/toast.js";
import { fmtCost, fmtCount, fmtDuration, fmtPct, fmtStat } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, refreshProject, emptyState, openSheet, sheetBusy } from "./_shared.js";
import { piiSummary } from "./import.js";

export const route = "p/:slug/corpus/:cid/instant";
export const title = "Instant Read";

const LANG_LABELS = { en: "English", es: "Spanish", other: "Other" };

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const read = await api.corpora.instantRead(params.slug, params.cid);
    return { project, read };
  }, ({ project, read }) => {
    if (!read || !read.lengthHist) {
      mount.append(emptyState({
        title: "Nothing to read yet.",
        body: "This corpus returned no instant read — the import created no units, or the file held no codable text.",
        actions: [el("a", { class: "btn", href: `#/p/${params.slug}/import` }, "Back to import")],
      }));
      return;
    }

    // bins → unit ids rides the live read (older cached reads upgrade on
    // GET); only claim clickability when the data actually carries the doors
    const hasEvidence = Boolean(read.langUnits);
    mount.append(screenHead({
      overline: "Instant read",
      title: "An overview of the corpus computed locally, before any model reads it.",
      lede: "Local counts only — lengths, languages, distinctive terms, metadata."
        + (hasEvidence ? " Click any bar to read its units." : "")
        + " The Brief below reads a stratified sample and cites the units behind every claim.",
      actions: [
        el("span", { class: "chip chip--ghost localbadge", title: "Computed from bundled lexicons and local statistics" },
          "⌂ statistics computed locally — no model reads your data here",
          read.unitCount ? el("span", { class: "data" }, ` · ${fmtCount(read.unitCount)} units`) : null),
      ],
    }));

    /* -- the unit-text statement: the single most load-bearing fact on this
       screen — WHICH column every number below is computed over. Full-width,
       screen-title scale, with a real Change button. The scope chip (rows
       kept, exclusions) rides beneath it; this replaces the old small inline
       affordance. -- */
    const corpusEntry = (project?.corpora ?? []).find((c) => c.id === params.cid) ?? null;
    const scope = read.scope
      ? { ...read.scope, derivedFrom: scopechip.resolveDerived(read.scope.derivedFrom, project) }
      : scopechip.fromCorpus(corpusEntry, project);
    const textCol = scope?.textColumn ?? null;
    const unitN = read.unitCount ?? corpusEntry?.unitCount ?? null;
    mount.append(el("div", { class: "unittext" },
      el("div", { class: "unittext__line" },
        el("p", { class: "unittext__statement" },
          el("span", { class: "unittext__label" }, "Unit text:"),
          " ",
          textCol
            ? el("span", { class: "unittext__col" }, textCol)
            : el("span", { class: "unittext__col unittext__col--unset" }, "not recorded"),
          unitN !== null
            ? el("span", { class: "unittext__count data" }, ` · ${fmtCount(unitN)} units`)
            : null),
        el("button", {
          class: "btn unittext__change", type: "button",
          title: "Pick a different column as the unit text — builds a new corpus; this one is kept",
          onclick: () => changeTextColumn(params, project, textCol),
        }, textCol ? "Change…" : "Set the column…")),
      scope ? el("div", { class: "unittext__scope" }, scopechip.render(scope)) : null,
    ));

    const grid = el("div", { class: "irgrid" });
    mount.append(grid);

    // bar.js datum contract: `evidence` (unit id list, ≤100) opens the
    // inspector; `evidenceTotal` is the true n behind the door
    const evidenceOf = (unitIds, n) =>
      (Array.isArray(unitIds) && unitIds.length > 0 ? { evidence: unitIds, evidenceTotal: n } : {});

    /* -- length histogram: {bins: [{lo, hi, n, unitIds}], unit} -- */
    const lengthCell = el("div", { class: "irgrid__cell" });
    const lengthUnit = read.lengthHist.unit ?? "words";
    bar.render(lengthCell, (read.lengthHist.bins ?? []).map((b) => ({
      label: `${fmtCount(b.lo)}–${fmtCount(b.hi)}`,
      value: b.n,
      ...evidenceOf(b.unitIds, b.n),
    })), {
      caption: `Units by length (${lengthUnit})`,
      format: (v) => fmtCount(v),
      level: null,
      labelWidth: 110,
    });
    grid.append(wrapCell("Length", lengthCell));

    /* -- language mix: {en, es, other} shares; evidence via langUnits -- */
    const langCell = el("div", { class: "irgrid__cell" });
    bar.render(langCell, Object.entries(read.langMix ?? {})
      .filter(([, share]) => share > 0)
      .map(([lang, share]) => ({
        label: `${LANG_LABELS[lang] ?? lang} (${fmtPct(share, 1)})`,
        value: share,
        ...evidenceOf(read.langUnits?.[lang]?.unitIds, read.langUnits?.[lang]?.n),
      })), {
      caption: "Language mix — detected locally",
      format: (v) => fmtPct(v, 1),
      labelWidth: 140,
      domain: [0, 1],
    });
    grid.append(wrapCell("Languages", langCell));

    /* -- top distinctive terms: [{term, count}] -- */
    const termList = el("ol", { class: "termcols", role: "list" },
      ...(read.topTerms ?? []).map((t) =>
        el("li", { class: "termcols__item" },
          el("span", { class: "termcols__term data" }, t.term),
          el("span", { class: "termcols__nums data faint" }, fmtCount(t.count)),
        )),
    );
    grid.append(wrapCell("Top distinctive terms", termList,
      el("p", { class: "faint screen__hint" }, "Frequency damped by document frequency, stopwords removed. These are raw counts, not an interpretation.")));

    /* -- sentiment sketch: {lexicon, positive, negative, neutral, meanValence};
       evidence via sentimentUnits -- */
    const sketch = read.sentimentSketch ?? {};
    const sentCell = el("div", { class: "irgrid__cell" });
    bar.render(sentCell, ["positive", "neutral", "negative"].map((bucket) => ({
      label: bucket,
      value: sketch[bucket] ?? 0,
      ...evidenceOf(read.sentimentUnits?.[bucket]?.unitIds, read.sentimentUnits?.[bucket]?.n),
    })), {
      caption: `Share of units by ${sketch.lexicon ?? "VADER"} valence — mean net valence ${fmtStat(sketch.meanValence)} (VADER lexicon weight sum — not the VADER compound score). A sketch, not a finding: sarcasm defeats lexicons.`,
      format: (v) => fmtPct(v, 1),
      level: "exploratory",
      domain: [0, 1],
      labelWidth: 110,
    });
    grid.append(wrapCell("Sentiment sketch", sentCell));

    /* -- metadata marginals: [{column, values: [{value, n, unitIds}]}] -- */
    const mmCell = el("div", { class: "irgrid__wide" });
    smallmultiples.render(mmCell, {
      items: (read.metaMarginals ?? []).map((m) => ({
        title: m.column,
        data: (m.values ?? []).map((v) => ({
          label: String(v.value),
          value: v.n,
          ...evidenceOf(v.unitIds, v.n),
        })),
      })),
      renderFn: bar.render,
      sharedDomain: false,
      opts: { format: (v) => fmtCount(v), labelWidth: 84, valueWidth: 54 },
      caption: "Metadata marginals — who is in this corpus",
    });
    mount.append(section("Metadata", mmCell));

    /* -- the CTA — always priced (briefEstimate {usd, etaMin} | null) -- */
    const est = read.briefEstimate ?? null;
    const isMock = project?.director?.provider === "mock";
    const priceTag = est
      ? (isMock ? `${fmtCost(0)} · Mock` : `~${fmtCost(est.usd)}, ${fmtDuration(est.etaMin)}`)
      : null;
    mount.append(el("div", { class: "ctacard" },
      el("div", { class: "ctacard__text" },
        el("h3", { class: "ctacard__title" }, "Generate the Corpus Brief"),
        el("p", { class: "ctacard__line" },
          "The Director reads a stratified sample and writes a typeset memo: what this data is, candidate themes anchored to real quotes, red flags. Every claim cites its units."),
        est === null
          ? el("p", { class: "ctacard__line faint" },
              "No price to quote yet — choose a Director model in ",
              el("a", { href: `#/p/${params.slug}/settings` }, "this project's Settings"),
              " (keyless demo: choose Mock).")
          : el("p", { class: "ctacard__line faint" },
              "(price from provider catalog — fetching it sends no corpus data)"),
      ),
      el("button", {
        class: "btn btn--primary btn--lg", type: "button",
        onclick: () => router.navigate(`p/${params.slug}/brief/new?corpus=${params.cid}`),
      }, priceTag ? `Generate the Corpus Brief — ${priceTag}` : "Generate the Brief"),
    ));
  }, "Counting the corpus…");

  function wrapCell(label, ...children) {
    return el("section", { class: "irgrid__section" },
      el("h3", { class: "overline screen__section-label" }, label),
      ...children,
    );
  }
}

/* ---- change the unit text column — the recovery path for wrong-column
   imports. Probes the first units client-side, ranks metadata keys by mean
   string length, and confirms into POST corpora/:c/reunitize, which builds a
   NEW corpus (the original is kept). ------------------------------------------ */

function changeTextColumn(params, project, currentCol) {
  const s = openSheet({ title: "Change the unit text column", overline: "Re-unitize this corpus" });

  s.body.append(el("p", { class: "screen__hint" },
    currentCol
      ? `Units currently read their text from “${currentCol}”. `
      : "This corpus does not record which column its text came from. ",
    "Pick the column Concord should measure instead. Confirming builds a ",
    el("strong", {}, "new corpus"),
    " from that column — this one stays unchanged, so nothing built on it breaks."));

  const listHost = el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Unit text column" } },
    el("p", { class: "faint" }, "Reading the first units to find text-like columns…"));
  s.body.append(listHost);

  let chosen = null;
  const confirmBtn = el("button", {
    class: "btn btn--primary", type: "button", disabled: true,
    onclick: async () => {
      if (!chosen) return;
      const stop = sheetBusy(s, confirmBtn, {
        label: (sec) => `Re-unitizing from ${chosen} · ${sec}s`,
        hint: "building a new corpus from that column — the original is kept",
      });
      try {
        const res = await api.corpora.reunitize(params.slug, params.cid, { textColumn: chosen });
        stop();
        s.close();
        // the server re-runs the source corpus's pii mode on the new units;
        // say what that pass found/replaced, same line as import-confirm
        const piiLine = piiSummary(res.pii);
        toast.success(`Re-unitized — ${fmtCount(res.unitCount)} units now read from “${res.textColumn}”.`, {
          detail: `${fmtCount(res.skipped ?? 0)} rows skipped (empty in that column) · the original corpus is kept`
            + (piiLine ? ` · ${piiLine}` : ""),
          data: true,
        });
        await refreshProject(params.slug).catch(() => {});
        router.navigate(`p/${params.slug}/corpus/${res.corpusId}/instant`);
      } catch (err) {
        stop();
        paintFoot();
        toast.error("Re-unitize failed.", { detail: String(err.message ?? err) });
      }
    },
  }, "Re-unitize");
  const paintFoot = () => s.foot.replaceChildren(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    confirmBtn,
  );
  paintFoot();

  (async () => {
    let candidates = [];
    try {
      const page = await api.corpora.units(params.slug, params.cid, { limit: 12 });
      candidates = rankTextyColumns(page?.units ?? []);
    } catch (err) {
      clear(listHost).append(el("p", { class: "faint" },
        "Could not read sample units: ", String(err.message ?? err)));
      return;
    }
    clear(listHost);
    if (!candidates.length) {
      listHost.append(el("p", { class: "faint" },
        "No metadata columns to read from — this corpus carries only its unit text."));
      return;
    }
    for (const c of candidates) {
      listHost.append(el("label", { class: "choice" },
        el("input", {
          type: "radio", name: "unit-text-col", value: c.key,
          onchange: () => {
            chosen = c.key;
            confirmBtn.disabled = false;
            confirmBtn.textContent = `Re-unitize — unit text from ${c.key}`;
          },
        }),
        el("span", { class: "choice__text" },
          el("span", { class: "choice__label" },
            el("span", { class: "data" }, c.key),
            el("span", { class: "chip chip--ghost data" }, `~${fmtCount(c.meanLen)} chars`)),
          c.preview ? el("span", { class: "choice__preview data" }, c.preview) : null)));
    }
    listHost.append(el("p", { class: "screen__hint faint" },
      "Columns ranked by mean text length over the first units — longer columns are usually the open-ended answer text."));
  })();
}

/** Rank a unit sample's metadata keys by mean string length (texty first). */
function rankTextyColumns(units, topN = 8) {
  const stats = new Map(); // key → {sum, n, preview}
  for (const u of units) {
    for (const [key, value] of Object.entries(u?.meta ?? {})) {
      if (value === null || value === undefined) continue;
      const str = String(value);
      const rec = stats.get(key) ?? { sum: 0, n: 0, preview: "" };
      rec.sum += str.length;
      rec.n += 1;
      if (!rec.preview && str.trim()) {
        rec.preview = str.length > 90 ? str.slice(0, 90) + "…" : str;
      }
      stats.set(key, rec);
    }
  }
  return [...stats.entries()]
    .map(([key, r]) => ({ key, meanLen: Math.round(r.sum / Math.max(1, r.n)), preview: r.preview }))
    .sort((a, b) => b.meanLen - a.meanLen)
    .slice(0, topN);
}
