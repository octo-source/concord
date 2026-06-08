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
import * as scopechip from "../components/scopechip.js";
import { fmtCount, fmtDate } from "../format.js";
import { section, emptyState, errorView, ensureProject, setReading, backLink, mdInline } from "./_shared.js";

export const route = "p/:slug/brief/:bid";
export const title = "Corpus Brief";

let stream = null;
let composeTimer = null;

export function render(mount, params, query) {
  setReading(true);
  const column = el("article", { class: "brief" });
  mount.append(el("div", { class: "brief__back" }, backLink(`p/${params.slug}`, "Project")), column);

  // destroy() can run before ensureProject() resolves (navigate away during
  // the project load). The stream is still null then, so closing it is a
  // no-op; without this flag the late .then would open a leaked SSE + 1s
  // interval on a screen that is already gone.
  let cancelled = false;

  ensureProject(params.slug)
    .then((project) => {
      if (cancelled) return;
      if (params.bid === "new") {
        startStream(column, params, query, project);
      } else {
        renderStored(column, params, project);
      }
    })
    .catch((err) => { if (!cancelled) clear(column).append(errorView(err)); });

  return {
    el: mount,
    destroy() {
      cancelled = true;
      stream?.close?.();
      stream = null;
      clearInterval(composeTimer);
      composeTimer = null;
      setReading(false);
    },
  };
}

/* The brief reads ONE text column and summarizes ALL metadata columns — the
   scope chip under the byline says exactly that. Stored artifacts may carry
   their own textColumn/metaColumns; otherwise the corpus entry answers. */
function briefScope(project, corpusId, artifact = null) {
  const corpusEntry = (project?.corpora ?? []).find((c) => c.id === corpusId) ?? null;
  const base = scopechip.fromCorpus(corpusEntry, project);
  if (!base && !artifact?.textColumn) return null;
  return scopechip.render({
    ...(base ?? {}),
    textColumn: artifact?.textColumn ?? base?.textColumn ?? null,
    metaColumns: artifact?.metaColumns ?? base?.metaColumns ?? null,
    allMeta: true,
  });
}

/* ---- streamed (new) ---------------------------------------------------------- */

function startStream(column, params, query, project) {
  const corpusId = query.corpus ?? project?.corpora?.[0]?.id;
  column.append(briefHead({
    title: "Corpus Brief",
    byline: "Drafting now — paragraphs appear as the Director reads the sample.",
    sampleN: null,
    date: new Date().toISOString(),
  }));
  const scopeEl = briefScope(project, corpusId);
  if (scopeEl) column.append(scopeEl);

  const body = el("div", { class: "brief__body", aria: { live: "polite" } });
  const composeText = el("span", {});
  const composing = el("p", { class: "brief__composing", role: "status" },
    el("span", { class: "brief__cursor", aria: { hidden: "true" } }, "▍"),
    composeText);
  column.append(body, composing);

  // Live status: the server streams the stage it is actually in (sampling →
  // prompt-composed → director-called → tick {elapsed} every ~2s during the
  // one long call → validating); the clock shows elapsed seconds. Server
  // ticks also repaint, so a throttled background tab still advances.
  const startedAt = Date.now();
  const status = { line: "Contacting the server", serverElapsed: 0 };
  const paint = () => {
    const sec = Math.max(status.serverElapsed, Math.round((Date.now() - startedAt) / 1000));
    composeText.textContent = ` ${status.line} · ${sec}s`;
  };
  paint();
  clearInterval(composeTimer);
  composeTimer = setInterval(paint, 1000);
  const stopClock = () => { clearInterval(composeTimer); composeTimer = null; };

  let sampleN = null;
  const onStage = (event, data) => {
    if (event === "sampling") {
      sampleN = typeof data?.sampleN === "number" ? data.sampleN : null;
      status.line = sampleN !== null
        ? `Sampled ${fmtCount(sampleN)} of ${fmtCount(data?.unitCount ?? sampleN)} units`
        : "Sampling the corpus";
    } else if (event === "prompt-composed") {
      status.line = "Prompt composed";
    } else if (event === "director-called") {
      const sample = sampleN !== null ? `the ${fmtCount(sampleN)}-unit sample` : "the sample";
      status.line = data?.model
        ? `The Director (${data.model}) is reading ${sample}`
        : `The Director is reading ${sample}`;
    } else if (event === "tick") {
      if (typeof data?.elapsed === "number") status.serverElapsed = data.elapsed;
    } else if (event === "validating") {
      status.line = "Checking that every cited unit was in the sample";
    }
    paint();
  };

  const paras = [];
  stream = api.brief.generate(params.slug, corpusId, {
    onEvent: onStage,
    onParagraph(para) {
      if (paras.length === 0) {
        status.line = "Paragraphs arriving";
        paint();
      }
      paras.push(para);
      body.append(paragraphEl(para, paras.length));
    },
    onDone({ briefId } = {}) {
      stopClock();
      composing.remove();
      toast.success("Corpus Brief drafted.", { detail: briefId, data: true });
      // re-enter through the stored route so refresh/share works
      if (briefId) router.navigate(`p/${params.slug}/brief/${briefId}`, { replace: true });
    },
    onError(err) {
      stopClock();
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
      title: "This brief was not found.",
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
  const scopeEl = briefScope(project, brief.corpusId, brief);
  if (scopeEl) column.append(scopeEl);

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
          el("p", { class: "ctacard__line" }, "Accept themes as constructs, compile instruments, and preflight a run. Each step shows its price before it spends.")),
        el("button", {
          class: "btn btn--primary", type: "button",
          onclick: () => router.navigate(`p/${params.slug}/constructs`),
        }, "Open the codebook")),
    ));
  }

  /* -- red flags: [{kind, detail, refs}] -- */
  if (brief.redFlags?.length) {
    column.append(section("Red flags",
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
    column.append(section("Suggested questions",
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
