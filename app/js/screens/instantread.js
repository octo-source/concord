// Instant Read — #/p/:slug/corpus/:cid/instant — the first look, computed
// locally in under a second: length histogram, language mix, top distinctive
// terms in a two-column mono list, a VADER sentiment sketch, and metadata
// marginals as small multiples. The one CTA leads to the Corpus Brief.
//
// Live contract (GET corpora/:c/instantread):
//   local: true, unitCount,
//   lengthHist:      {bins: [{lo, hi, n}], unit: "words"}
//   langMix:         {en, es, other} — shares that sum to ~1
//   topTerms:        [{term, count}] — tf·idf-ranked, stopworded
//   sentimentSketch: {lexicon: "VADER", positive, negative, neutral, meanValence}
//   metaMarginals:   [{column, values: [{value, n}]}]
//   briefEstimate:   {usd, etaMin} | null — the CTA's price tag (design §6.1:
//                    the level-up affordance always states its price); null
//                    only when no Director slot is configured
//   computedAt:      ISO timestamp (also the cache marker)

import { el } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as bar from "../components/charts/bar.js";
import * as smallmultiples from "../components/charts/smallmultiples.js";
import { fmtCost, fmtCount, fmtDuration, fmtPct, fmtStat } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, emptyState } from "./_shared.js";

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
        body: "This corpus has no instant read — import may still be running.",
        actions: [el("a", { class: "btn", href: `#/p/${params.slug}/import` }, "Back to import")],
      }));
      return;
    }

    mount.append(screenHead({
      overline: "Instant read",
      title: "What the corpus looks like before anyone reads it.",
      lede: "Counted, not interpreted. Every bar opens onto the units beneath it.",
      actions: [
        el("span", { class: "chip chip--ghost localbadge", title: "Computed from bundled lexicons and local statistics" },
          "⌂ all local — no API calls",
          read.unitCount ? el("span", { class: "data" }, ` · ${fmtCount(read.unitCount)} units`) : null),
      ],
    }));

    const grid = el("div", { class: "irgrid" });
    mount.append(grid);

    /* -- length histogram: {bins: [{lo, hi, n}], unit} -- */
    const lengthCell = el("div", { class: "irgrid__cell" });
    const lengthUnit = read.lengthHist.unit ?? "words";
    bar.render(lengthCell, (read.lengthHist.bins ?? []).map((b) => ({
      label: `${fmtCount(b.lo)}–${fmtCount(b.hi)}`,
      value: b.n,
    })), {
      caption: `Units by length (${lengthUnit})`,
      format: (v) => fmtCount(v),
      level: null,
      labelWidth: 110,
    });
    grid.append(wrapCell("Length", lengthCell));

    /* -- language mix: {en, es, other} shares -- */
    const langCell = el("div", { class: "irgrid__cell" });
    bar.render(langCell, Object.entries(read.langMix ?? {})
      .filter(([, share]) => share > 0)
      .map(([lang, share]) => ({
        label: `${LANG_LABELS[lang] ?? lang} (${fmtPct(share, 1)})`,
        value: share,
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
      el("p", { class: "faint screen__hint" }, "Frequency damped by document frequency, stopwords removed. Counted, not judged.")));

    /* -- sentiment sketch: {lexicon, positive, negative, neutral, meanValence} -- */
    const sketch = read.sentimentSketch ?? {};
    const sentCell = el("div", { class: "irgrid__cell" });
    bar.render(sentCell, [
      { label: "positive", value: sketch.positive ?? 0 },
      { label: "neutral", value: sketch.neutral ?? 0 },
      { label: "negative", value: sketch.negative ?? 0 },
    ], {
      caption: `Share of units by ${sketch.lexicon ?? "VADER"} valence — mean ${fmtStat(sketch.meanValence)}. A sketch, not a finding: sarcasm defeats lexicons.`,
      format: (v) => fmtPct(v, 1),
      level: "exploratory",
      domain: [0, 1],
      labelWidth: 110,
    });
    grid.append(wrapCell("Sentiment sketch", sentCell));

    /* -- metadata marginals: [{column, values: [{value, n}]}] -- */
    const mmCell = el("div", { class: "irgrid__wide" });
    smallmultiples.render(mmCell, {
      items: (read.metaMarginals ?? []).map((m) => ({
        title: m.column,
        data: (m.values ?? []).map((v) => ({ label: String(v.value), value: v.n })),
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
          : null,
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
