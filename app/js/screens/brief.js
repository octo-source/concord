// Corpus Brief — #/p/:slug/brief/:bid — the full-bleed reading column. With
// :bid = "new" (?corpus=…) the screen opens the SSE stream and paragraphs
// compose in as the Director writes them; an existing :bid renders from the
// project's stored brief artifact. Margin quote-pulls anchor claims to real
// units; every ref is a door into the evidence inspector. Themes close with
// the one paid action ("Explore these themes", price stated); red flags render
// as honest annotations. The byline wears the Director glyph.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as quotecard from "../components/quotecard.js";
import * as glyph from "../components/glyph.js";
import * as ladder from "../components/ladder.js";
import { fmtCount, fmtDate, fmtPct } from "../format.js";
import { section, emptyState, errorView, ensureProject, estimateChips, setReading, backLink, mdInline } from "./_shared.js";

export const route = "p/:slug/brief/:bid";
export const title = "Corpus Brief";

let stream = null;

export function render(mount, params, query) {
  setReading(true);
  const column = el("article", { class: "brief" });
  mount.append(el("div", { class: "brief__back" }, backLink(`p/${params.slug}`, "Project")), column);

  ensureProject(params.slug)
    .then((project) => {
      if (params.bid === "new") {
        startStream(column, params, query, project);
      } else {
        renderStored(column, params, project);
      }
    })
    .catch((err) => clear(column).append(errorView(err)));

  return {
    el: mount,
    destroy() {
      stream?.close?.();
      stream = null;
      setReading(false);
    },
  };
}

/* ---- streamed (new) ---------------------------------------------------------- */

function startStream(column, params, query, project) {
  const corpusId = query.corpus ?? project?.corpora?.[0]?.id;
  column.append(briefHead({
    title: "Corpus Brief",
    byline: "Drafting now — paragraphs arrive as the Director reads.",
    sampleN: null,
    date: new Date().toISOString(),
  }));

  const body = el("div", { class: "brief__body", aria: { live: "polite" } });
  const composing = el("p", { class: "brief__composing", role: "status" },
    el("span", { class: "brief__cursor", aria: { hidden: "true" } }, "▍"),
    " reading a stratified sample…");
  column.append(body, composing);

  const paras = [];
  stream = api.brief.generate(params.slug, corpusId, {
    onParagraph(para) {
      paras.push(para);
      body.append(paragraphEl(para, paras.length));
    },
    onDone({ briefId } = {}) {
      composing.remove();
      toast.success("Corpus Brief drafted.", { detail: briefId, data: true });
      // re-enter through the stored route so refresh/share works
      if (briefId) router.navigate(`p/${params.slug}/brief/${briefId}`, { replace: true });
    },
    onError(err) {
      composing.remove();
      column.append(errorView(err, { retry: () => { clear(column); startStream(column, params, query, project); } }));
    },
  });
}

/* ---- stored ------------------------------------------------------------------- */

async function renderStored(column, params, project) {
  // No GET /briefs/:id route exists yet (api.js gap) — the artifact rides on
  // the project graph in fixtures and (eventually) on the server's project
  // response. Fall back to the fixtures brief shape if present.
  let brief = (project?.briefs ?? []).find((b) => b.id === params.bid) ?? null;
  if (brief && !brief.paragraphs) {
    // meta only — try the fixtures-installed full artifact via a tolerant call
    try {
      const full = await tryFixturesBrief(params.bid);
      if (full) brief = full;
    } catch { /* stay with meta */ }
  }
  if (!brief) {
    column.append(emptyState({
      title: "This brief is not on the shelf.",
      body: "It may not exist, or the server cannot return stored briefs yet.",
      actions: [el("a", { class: "btn", href: `#/p/${params.slug}/brief/new` }, "Draft a new brief")],
    }));
    return;
  }
  if (!brief.paragraphs) {
    column.append(emptyState({
      title: "The brief's text is not retrievable.",
      body: "The project lists this brief, but the server has no route to return its paragraphs yet (GET briefs/:id).",
      hint: "Regenerating re-streams it.",
      actions: [el("a", { class: "btn", href: `#/p/${params.slug}/brief/new` }, "Regenerate")],
    }));
    return;
  }

  column.append(briefHead({
    title: brief.title ?? "Corpus Brief",
    byline: null,
    humanTouched: brief.humanTouched,
    sampleN: brief.sampleN,
    sampleDesign: brief.sampleDesign,
    date: brief.createdAt,
    model: brief.model,
    costUSD: brief.costUSD,
  }));

  const body = el("div", { class: "brief__body" });
  (brief.paragraphs ?? []).forEach((para, i) => body.append(paragraphEl(para, i + 1, { instant: false })));
  column.append(body);

  /* -- themes -- */
  if (brief.themes?.length) {
    const themeList = el("ul", { class: "themelist", role: "list" },
      ...brief.themes.map((t) =>
        el("li", { class: "theme" },
          el("div", { class: "theme__head" },
            el("span", { class: "theme__name" }, t.label ?? t.name),
            el("span", { class: "theme__share data" }, fmtPct(t.share, 0), " ", ladder.render({ level: "exploratory", size: "sm" }))),
          t.refs?.length
            ? el("p", { class: "theme__refs" },
                "anchors: ",
                ...t.refs.map((id) => refChip(id)))
            : null,
        )),
    );
    const est = brief.exploreEstimate ?? {};
    column.append(section("Candidate themes",
      themeList,
      el("div", { class: "ctacard ctacard--inline" },
        el("div", { class: "ctacard__text" },
          el("h3", { class: "ctacard__title" }, "Explore these themes"),
          el("p", { class: "ctacard__line" }, est.note ?? "Compile instruments from these themes and run them across the corpus."),
          el("p", { class: "ctacard__est" }, estimateChips({ units: est.units, calls: est.calls, usd: est.usd, etaMin: est.etaMin }))),
        el("button", {
          class: "btn btn--primary", type: "button",
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              // compile = version the tuned judge via the Director, then hand off to preflight
              await api.instruments.compile(params.slug, "inst_judge_s").catch(() => {});
              toast.success("Instruments compiled from the brief's themes.", { detail: "review them under Instruments — then preflight the run" });
              router.navigate(`p/${params.slug}/runs?preflight=inst_judge_s`);
            } catch (err) {
              e.target.disabled = false;
              toast.error("Compilation failed.", { detail: String(err.message ?? err) });
            }
          },
        }, "Compile & preflight")),
    ));
  }

  /* -- red flags -- */
  if (brief.redFlags?.length) {
    column.append(section("Red flags, honestly stated",
      el("ul", { class: "flaglist", role: "list" },
        ...brief.redFlags.map((f) =>
          el("li", { class: "flag" },
            el("span", { class: "chip chip--signal" }, f.kind),
            el("span", { class: "flag__note" }, f.note, " ",
              ...(f.refs ?? []).map((id) => refChip(id))),
          ))),
    ));
  }
}

async function tryFixturesBrief(bid) {
  // fixtures keep the full artifact at fixtures/brief.json; live servers will
  // eventually serve GET /briefs/:id. This helper stays harmless either way.
  try {
    const res = await fetch("fixtures/brief.json");
    if (!res.ok) return null;
    const b = await res.json();
    return b.id === bid ? b : null;
  } catch {
    return null;
  }
}

/* ---- pieces ------------------------------------------------------------------------ */

function briefHead({ title: t, byline, humanTouched = false, sampleN, sampleDesign, date, model, costUSD }) {
  return el("header", { class: "brief__head" },
    el("p", { class: "overline" }, "Corpus brief"),
    el("h1", { class: "brief__title" }, t),
    el("p", { class: "brief__byline" },
      el("span", { class: "brief__author" },
        "Drafted by the Director",
        glyph.render({ authoredBy: "director", humanTouched })),
      date ? el("span", { class: "data faint" }, " · ", fmtDate(date)) : null,
      sampleN ? el("span", { class: "data faint" }, ` · ${fmtCount(sampleN)}-unit sample${sampleDesign ? ` (${sampleDesign})` : ""}`) : null,
      model ? el("span", { class: "data faint" }, ` · ${model}`) : null,
      costUSD !== undefined && costUSD !== null ? el("span", { class: "data faint" }, ` · $${costUSD.toFixed(2)}`) : null,
      byline ? el("span", { class: "faint" }, " ", byline) : null,
    ),
  );
}

function paragraphEl(para, n, { instant = false } = {}) {
  const refs = para.refs ?? [];
  const p = el("div", { class: `brief__para${instant ? "" : " brief__para--compose"}`, style: { "--i": String(n) } },
    el("p", { class: "brief__text" }, ...mdInline(para.md ?? "")),
    refs.length
      ? el("p", { class: "brief__refs" },
          el("span", { class: "overline brief__refs-label" }, "evidence"),
          ...refs.map((id) => refChip(id)))
      : null,
  );
  // margin quote-pull for the first ref — the human voice beside the claim
  if (refs.length) {
    const pull = el("aside", { class: "brief__pull" });
    p.append(pull);
    api.evidence.get(currentSlug(), refs[0])
      .then((dossier) => {
        if (!dossier?.unit?.text) return;
        const unit = { ...dossier.unit, meta: undefined, pos: undefined };
        pull.append(quotecard.render({ unit, lang: dossier.lang, compact: true, evidence: true }));
      })
      .catch(() => pull.remove());
  }
  return p;
}

function refChip(unitId) {
  return el("button", {
    class: "refchip data evidence-door",
    type: "button",
    dataset: { evidence: unitId },
    aria: { label: `Open evidence for ${unitId}` },
  }, shortId(unitId));
}

function shortId(id) {
  const s = String(id);
  return s.length > 12 ? s.slice(0, 8) + "…" : s;
}

function currentSlug() {
  return router.current()?.params?.slug ?? "";
}
