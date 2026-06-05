// Instant Read — #/p/:slug/corpus/:cid/instant — the first look, computed
// locally in under a second: length histogram, language mix, top distinctive
// terms in a two-column mono list, a VADER sentiment sketch (diverging bars),
// and metadata marginals as small multiples. The one CTA spends money and says
// exactly how much: Generate the Corpus Brief.

import { el } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as bar from "../components/charts/bar.js";
import * as smallmultiples from "../components/charts/smallmultiples.js";
import { fmt, fmtCount, fmtPct, fmtStat } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, estimateChips, emptyState } from "./_shared.js";

export const route = "p/:slug/corpus/:cid/instant";
export const title = "Instant Read";

export function render(mount, params) {
  asyncMount(mount, async () => {
    await ensureProject(params.slug);
    return api.corpora.instantRead(params.slug, params.cid);
  }, (read) => {
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
          read.computedIn ? el("span", { class: "data" }, ` · ${fmt(read.computedIn, 2)}s`) : null),
      ],
    }));

    const grid = el("div", { class: "irgrid" });
    mount.append(grid);

    /* -- length histogram -- */
    const lengthCell = el("div", { class: "irgrid__cell" });
    bar.render(lengthCell, (read.lengthHist ?? []).map((b) => ({
      label: b.label, value: b.value, evidence: b.evidence?.length ? b.evidence : undefined,
    })), {
      caption: "Units by length — click a bar to read examples",
      format: (v) => fmtCount(v),
      level: null,
      labelWidth: 110,
    });
    grid.append(wrapCell("Length", lengthCell));

    /* -- language mix -- */
    const langCell = el("div", { class: "irgrid__cell" });
    bar.render(langCell, (read.langMix ?? []).map((l) => ({
      label: `${l.label} (${fmtPct(l.share, 1)})`, value: l.value, evidence: l.evidence?.length ? l.evidence : undefined,
    })), {
      caption: "Language mix — detected locally",
      format: (v) => fmtCount(v),
      labelWidth: 140,
    });
    grid.append(wrapCell("Languages", langCell));

    /* -- top distinctive terms -- */
    const termList = el("ol", { class: "termcols", role: "list" },
      ...(read.topTerms ?? []).map((t) =>
        el("li", { class: "termcols__item" },
          el("span", { class: "termcols__term data" }, t.term),
          el("span", { class: "termcols__nums data faint" }, `${fmtCount(t.count)} · ×${fmt(t.lift, 1)}`),
        )),
    );
    grid.append(wrapCell("Top distinctive terms", termList,
      el("p", { class: "faint screen__hint" }, "Frequency × lift against a general-English baseline. Counted, not judged.")));

    /* -- sentiment sketch -- */
    const sentCell = el("div", { class: "irgrid__cell" });
    bar.render(sentCell, (read.sentimentSketch?.rows ?? []).map((r) => ({
      label: r.label, value: r.value, evidence: r.evidence?.length ? r.evidence : undefined,
    })), {
      caption: `Mean VADER compound by satisfaction — ${read.sentimentSketch?.method ?? "VADER"}. A sketch, not a finding: sarcasm defeats lexicons.`,
      format: (v) => fmtStat(v),
      level: "exploratory",
      domain: [-1, 1],
      labelWidth: 110,
    });
    grid.append(wrapCell("Sentiment sketch", sentCell));

    /* -- metadata marginals: small multiples -- */
    const mmCell = el("div", { class: "irgrid__wide" });
    smallmultiples.render(mmCell, {
      items: (read.metaMarginals ?? []).map((m) => ({
        title: m.key,
        data: m.items.map((i) => ({ label: i.label, value: i.value })),
      })),
      renderFn: bar.render,
      sharedDomain: false,
      opts: { format: (v) => fmtCount(v), labelWidth: 84, valueWidth: 54 },
      caption: "Metadata marginals — who is in this corpus",
    });
    mount.append(section("Metadata", mmCell));

    /* -- the CTA, cost-labeled -- */
    const est = read.briefEstimate ?? {};
    mount.append(el("div", { class: "ctacard" },
      el("div", { class: "ctacard__text" },
        el("h3", { class: "ctacard__title" }, "Generate the Corpus Brief"),
        el("p", { class: "ctacard__line" },
          "The Director reads a stratified sample and writes a typeset memo: what this data is, candidate themes anchored to real quotes, red flags. Every claim cites its units."),
        el("p", { class: "ctacard__est" },
          estimateChips({ units: est.sampleN, usd: est.usd, etaMin: est.etaMin }),
          est.model ? el("span", { class: "chip" }, est.model) : null),
      ),
      el("button", {
        class: "btn btn--primary btn--lg", type: "button",
        onclick: () => router.navigate(`p/${params.slug}/brief/new?corpus=${params.cid}`),
      }, "Generate the Brief"),
    ));
  }, "Counting the corpus…");

  function wrapCell(label, ...children) {
    return el("section", { class: "irgrid__section" },
      el("h3", { class: "overline screen__section-label" }, label),
      ...children,
    );
  }
}
