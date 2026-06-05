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
import { fmtCount, fmtDate } from "../format.js";
import { section, emptyState, errorView, ensureProject, setReading, backLink, mdInline } from "./_shared.js";

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

// Live artifact (GET briefs/:bid): {id, corpusId, createdAt, authoredBy,
// humanTouched, unitOfAnalysis, paragraphs: [{md, refs}], themes: [{name,
// definition, quoteRefs}], redFlags: [{kind, detail, refs}],
// suggestedQuestions, sample: {n, design, …}, issues: {invalidRefs}}.
async function renderStored(column, params, project) {
  let brief = null;
  try {
    brief = await api.brief.get(params.slug, params.bid);
  } catch (err) {
    if (err?.status !== 404 && err?.code !== "NOT_FOUND") {
      column.append(errorView(err));
      return;
    }
  }
  if (!brief) {
    column.append(emptyState({
      title: "This brief is not on the shelf.",
      body: "It may not exist, or it was generated on another machine and the artifact never synced.",
      actions: [el("a", { class: "btn", href: `#/p/${params.slug}/brief/new` }, "Draft a new brief")],
    }));
    return;
  }

  column.append(briefHead({
    title: "Corpus Brief",
    byline: null,
    humanTouched: brief.humanTouched,
    sampleN: brief.sample?.n,
    sampleDesign: brief.sample?.design,
    date: brief.createdAt,
  }));

  if (brief.unitOfAnalysis) {
    column.append(el("p", { class: "brief__unitline faint" },
      el("span", { class: "overline" }, "unit of analysis"), " ", brief.unitOfAnalysis));
  }

  const body = el("div", { class: "brief__body" });
  (brief.paragraphs ?? []).forEach((para, i) => body.append(paragraphEl(para, i + 1, { instant: false })));
  column.append(body);

  /* -- themes: [{name, definition, quoteRefs}] -- */
  if (brief.themes?.length) {
    const themeList = el("ul", { class: "themelist", role: "list" },
      ...brief.themes.map((t) => {
        const refs = t.quoteRefs ?? [];
        return el("li", { class: "theme" },
          el("div", { class: "theme__head" },
            el("span", { class: "theme__name" }, t.name),
            el("span", { class: "theme__share data" },
              ladder.render({ level: "exploratory", size: "sm" }))),
          t.definition ? el("p", { class: "theme__def faint" }, t.definition) : null,
          refs.length
            ? el("p", { class: "theme__refs" },
                "anchors: ",
                ...refs.map((id) => refChip(id)))
            : null,
        );
      }),
    );
    column.append(section("Candidate themes",
      themeList,
      el("div", { class: "ctacard ctacard--inline" },
        el("div", { class: "ctacard__text" },
          el("h3", { class: "ctacard__title" }, "Explore these themes"),
          el("p", { class: "ctacard__line" }, "Accept themes as constructs, compile instruments, and preflight a run — every step states its price before it spends.")),
        el("button", {
          class: "btn btn--primary", type: "button",
          onclick: () => router.navigate(`p/${params.slug}/constructs`),
        }, "Open the codebook")),
    ));
  }

  /* -- red flags: [{kind, detail, refs}] -- */
  if (brief.redFlags?.length) {
    column.append(section("Red flags, honestly stated",
      el("ul", { class: "flaglist", role: "list" },
        ...brief.redFlags.map((f) =>
          el("li", { class: "flag" },
            el("span", { class: "chip chip--signal" }, f.kind),
            el("span", { class: "flag__note" }, f.detail, " ",
              ...(f.refs ?? []).map((id) => refChip(id))),
          ))),
    ));
  }

  /* -- suggested questions feed the Question Bar -- */
  if (brief.suggestedQuestions?.length) {
    column.append(section("Questions worth asking",
      el("ul", { class: "qsuggest", role: "list" },
        ...brief.suggestedQuestions.map((q) => el("li", { class: "qsuggest__item" }, "“", q, "”"))),
      el("p", { class: "faint screen__hint" }, "Type one into the Question Bar (", el("kbd", {}, "/"), ") — it compiles to a visible plan before anything spends.")));
  }
}

/* ---- pieces ------------------------------------------------------------------------ */

function briefHead({ title: t, byline, humanTouched = false, sampleN, sampleDesign, date }) {
  return el("header", { class: "brief__head" },
    el("p", { class: "overline" }, "Corpus brief"),
    el("h1", { class: "brief__title" }, t),
    el("p", { class: "brief__byline" },
      el("span", { class: "brief__author" },
        "Drafted by the Director",
        glyph.render({ authoredBy: "director", humanTouched })),
      date ? el("span", { class: "data faint" }, " · ", fmtDate(date)) : null,
      sampleN ? el("span", { class: "data faint" }, ` · ${fmtCount(sampleN)}-unit sample${sampleDesign ? ` (${sampleDesign})` : ""}`) : null,
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
