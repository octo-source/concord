// Constructs — #/p/:slug/constructs[/:id] — the codebook. A list pane and a
// structured editor: definition, include/exclude criteria, borderline-case
// rules, categories with EXPLICIT order (order feeds ordinal statistics), and
// a worked-examples table with kind chips. Director-authored constructs wear
// the attribution mark until the first human edit lands (humanTouched PUT).
// Draft with Director formalizes the USER's concepts (POST constructs/draft);
// Inductive mode asks the Director to propose themes FROM the corpus and is
// labeled hypothesis generation. Both Director sheets run their one paid
// action through sheetBusy: the button itself shows the present-tense label
// with the elapsed timer, and the sheet locks (Escape/scrim stop closing; ×
// becomes "Hide (keeps running)") so a stray click cannot read as a cancel.
// A module-level in-flight guard keeps repeat header clicks from stacking
// sheets or double-spending a call.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import { bus } from "../bus.js";
import { store } from "../state.js";
import * as toast from "../components/toast.js";
import * as glyph from "../components/glyph.js";
import * as pipeline from "../components/pipeline.js";
import * as quotecard from "../components/quotecard.js";
import * as scopechip from "../components/scopechip.js";
import { contextLine } from "../components/contextline.js";
import { screenHead, section, asyncMount, ensureProject, emptyState, openSheet, sheetBusy } from "./_shared.js";

export const route = "p/:slug/constructs";
export const routes = ["p/:slug/constructs", "p/:slug/constructs/:id"];
export const title = "Constructs";

const KINDS = ["positive", "negative", "nearmiss"];
// What each kind teaches the coder — shown as chip tooltips and in the
// section hint. The example line reaches the coder as `Label: X (<kind> example)`.
const KIND_HELP = {
  positive: "A clear case — teaches the center of its label.",
  negative: "Looks relevant but does not qualify — the label carries the correct answer (e.g. absent, no).",
  nearmiss: "A borderline case — the label shows which side of the line it falls.",
};
const TYPES = ["binary", "nominal", "ordinal", "continuous", "multilabel", "extraction"];

export function render(mount, params, query) {
  asyncMount(mount, async () => {
    await ensureProject(params.slug);
    return api.constructs.list(params.slug);
  }, (constructs) => {
    const selected = params.id ? constructs.find((k) => k.id === params.id) : null;

    mount.append(screenHead({
      overline: "Codebook",
      title: "Constructs",
      lede: "Define each thing you want to measure, precisely enough that a stranger — or a model — could apply it. Every instrument compiles from a construct.",
      actions: [
        el("button", { class: "btn", type: "button", onclick: () => newConstruct(params) }, "+ New construct"),
        el("button", { class: "btn", type: "button", onclick: () => draftWithDirector(params) }, `${glyph.GLYPH} Draft with Director`),
        el("button", { class: "btn", type: "button", onclick: () => importCodebook(params) }, "Import codebook"),
        el("button", { class: "btn btn--quiet", type: "button", onclick: () => inductiveMode(params) }, "Inductive mode"),
      ],
    }));

    const split = el("div", { class: "split" });
    mount.append(split);

    /* -- list pane -- */
    const list = el("nav", { class: "split__list", aria: { label: "Constructs" } });
    if (!constructs.length) {
      list.append(emptyState({
        title: "No constructs yet.",
        body: "What do you want to measure? Draft one with the Director, import a legacy codebook, or write your own.",
        actions: [
          el("button", { class: "btn btn--primary", type: "button", onclick: () => draftWithDirector(params) }, `${glyph.GLYPH} Draft with Director`),
          el("button", { class: "btn", type: "button", onclick: () => newConstruct(params) }, "+ New construct"),
        ],
      }));
    } else {
      const project = store.get("project");
      for (const k of constructs) {
        list.append(el("a", {
          class: `listitem${selected?.id === k.id ? " listitem--active" : ""}`,
          href: `#/p/${params.slug}/constructs/${k.id}`,
          aria: { current: selected?.id === k.id ? "true" : null },
        },
          el("span", { class: "listitem__name" }, k.name, glyph.render({ authoredBy: k.authoredBy, humanTouched: k.humanTouched ?? true })),
          el("span", { class: "listitem__meta" },
            el("span", { class: "chip" }, k.type),
            k.categories?.length ? el("span", { class: "chip chip--ghost data" }, `${k.categories.length} categories`) : null),
        ));
        // once anything reads this construct — an instrument or a gold set —
        // its agreement story has a home; the quiet door to it lives here
        const hasReadings = (project?.instruments ?? []).some((i) => i.constructId === k.id)
          || (project?.goldsets ?? []).some((g) => g.constructId === k.id);
        if (hasReadings) {
          list.append(el("a", {
            class: "listitem__aux",
            href: `#/p/${params.slug}/reliability/${encodeURIComponent(k.id)}`,
            title: "Every reading of this construct — humans, gold, instruments — and how much they agree",
          }, "reliability →"));
        }
      }
    }
    split.append(list);

    /* -- editor pane -- */
    const editorPane = el("div", { class: "split__main" });
    split.append(editorPane);
    if (selected) {
      editor(editorPane, params, selected, query);
    } else {
      editorPane.append(emptyState({
        title: constructs.length ? "Pick a construct to edit." : "The codebook is empty.",
        body: "A construct is a definition, its boundaries, its hard cases, and worked examples — the contract every instrument compiles from.",
      }));
    }
  }, "Opening the codebook…");
}

/* ---- editor --------------------------------------------------------------------- */

function editor(pane, params, construct, query = {}) {
  const k = JSON.parse(JSON.stringify(construct));
  let dirty = false;
  const glyphEl = glyph.render({ authoredBy: k.authoredBy, humanTouched: k.humanTouched ?? true });

  // disagreement screen hands off codebook defects via ?edgecase=unitId
  if (query.edgecase && !k.edgeCases?.some((e) => e.includes(query.edgecase))) {
    k.edgeCases = k.edgeCases ?? [];
    k.edgeCases.push(`From panel disagreement on ${query.edgecase}: (describe the boundary this unit exposes)`);
    dirty = true;
  }

  const touch = () => {
    dirty = true;
    if (!k.humanTouched) {
      k.humanTouched = true;
      glyph.update(glyphEl, { humanTouched: true });
    }
    saveBtn.disabled = false;
  };

  // after a save, the editor must say what comes next — a save that changes
  // nothing visible reads as a save that failed
  const nextStep = el("p", { class: "editor__next", hidden: true });

  // the one-click handoff: instruments?construct=<id>&compile=1 opens the
  // compile sheet over there, preselected on this construct
  const compileHref = `#/p/${params.slug}/instruments?construct=${encodeURIComponent(k.id)}&compile=1`;

  const saveBtn = el("button", {
    class: "btn btn--primary", type: "button", disabled: !dirty,
    onclick: async () => {
      saveBtn.disabled = true;
      try {
        await api.constructs.update(params.slug, k.id, k);
        const adopted = construct.authoredBy === "director" && !construct.humanTouched && k.humanTouched;
        toast.success("Construct saved.", { detail: adopted ? "Adopted — now yours to edit." : k.id, data: !adopted });
        dirty = false;
        nextStep.hidden = false;
        clear(nextStep).append(
          "Saved. Next: ",
          el("a", { href: compileHref }, "compile a judge instrument for this construct →"));
      } catch (err) {
        saveBtn.disabled = false;
        toast.error("Save failed.", { detail: String(err.message ?? err) });
      }
    },
  }, "Save");

  // where this construct sits in the pipeline, and the ONE next step
  const hasInstrument = (store.get("project")?.instruments ?? []).some((i) => i.constructId === k.id);
  pane.append(pipeline.render({
    current: "construct",
    states: hasInstrument ? { instrument: "done" } : {},
    action: hasInstrument
      ? { label: "Open its instrument →", href: `#/p/${params.slug}/instruments?construct=${encodeURIComponent(k.id)}` }
      : { label: "Compile a judge instrument →", href: compileHref },
  }));

  // sections whose copy/controls depend on the construct type re-render when
  // the type select changes (assigned where each section is built)
  let redrawCategories = () => {};
  let redrawExamples = () => {};

  pane.append(el("header", { class: "editor__head" },
    el("h3", { class: "editor__title" },
      el("input", {
        class: "input input--title", value: k.name, "aria-label": "Construct name",
        oninput: (e) => { k.name = e.target.value; touch(); },
      }),
      glyphEl),
    el("div", { class: "editor__headactions" },
      el("select", {
        class: "input input--inline", "aria-label": "Construct type",
        onchange: (e) => { k.type = e.target.value; touch(); redrawCategories(); redrawExamples(); },
      }, ...TYPES.map((t) => el("option", { value: t, selected: t === k.type }, t))),
      saveBtn),
  ));

  /* -- context: where this construct came from, and what measures it.
     draftedFrom is stamped by the Director's draft flow; legacy constructs
     simply omit the segment. -- */
  const project = store.get("project");
  const measuringInstruments = (project?.instruments ?? []).filter((i) => i.constructId === k.id);
  const draftedCorpus = k.draftedFrom
    ? (project?.corpora ?? []).find((c) => c.id === k.draftedFrom) ?? null
    : null;
  pane.append(contextLine([
    k.draftedFrom
      ? (draftedCorpus
          ? { label: "drafted from", text: scopechip.displayName(draftedCorpus), href: `#/p/${params.slug}/corpus/${draftedCorpus.id}/instant` }
          : { label: "drafted from", text: `${k.draftedFrom} — corpus no longer in this project`, faint: true })
      : null,
    measuringInstruments.length
      ? {
          label: "measured by",
          node: el("span", {}, ...measuringInstruments.flatMap((inst, i) => [
            i ? ", " : null,
            el("a", { class: "contextline__link", href: `#/p/${params.slug}/instruments/${inst.id}` }, inst.name, " →"),
          ])),
        }
      : { label: "measured by", text: "no instruments yet — compile one", href: compileHref },
  ]));
  pane.append(nextStep);

  /* definition */
  pane.append(section("Definition",
    el("textarea", {
      class: "input textarea", rows: 3, "aria-label": "Definition",
      value: k.definition ?? "",
      placeholder: "One or two sentences a stranger could apply — e.g. “The primary grievance the respondent treats as decisive. One label per unit: the deciding theme, not every theme mentioned.”",
      oninput: (e) => { k.definition = e.target.value; touch(); },
    }, k.definition ?? "")));

  /* criteria */
  const criteria = k.criteria ?? (k.criteria = { include: [], exclude: [] });
  pane.append(section("Criteria",
    el("p", { class: "screen__hint faint" },
      "Decision rules, sent to the coder word for word. Include when… — conditions that make a label apply. Exclude when… — evidence the coder must set aside."),
    el("div", { class: "twocol" },
      editList("Include when…", criteria.include, touch, {
        placeholder: "e.g. “Names pay, equity, or the comp process as a reason for leaving.”",
      }),
      editList("Exclude when…", criteria.exclude, touch, {
        placeholder: "e.g. “Mentions pay only to dismiss it (‘the pay was fine’).”",
      }))));

  /* categories — whether the order carries statistical meaning depends on
     the construct type, so the section re-renders when the type changes */
  const categoriesWrap = el("div");
  redrawCategories = () => {
    clear(categoriesWrap);
    if (!k.categories) return;
    categoriesWrap.append(k.type === "ordinal"
      ? section("Categories — order matters",
          el("p", { class: "screen__hint faint" }, "This order feeds ordinal statistics (weighted κ, ordinal α) and sets the coding-sprint number keys."),
          categoriesEditor(k, touch))
      : section("Categories",
          el("p", { class: "screen__hint faint" }, "Statistics treat these categories as unordered. The order here sets the coding-sprint number keys and the option order shown to model judges; for binary constructs with a dictionary instrument, the FIRST category is the positive label."),
          categoriesEditor(k, touch)));
  };
  redrawCategories();
  pane.append(categoriesWrap);

  /* edge cases — rules for borderline units, so coders (human or model)
     stop guessing */
  k.edgeCases = k.edgeCases ?? [];
  pane.append(section("Edge cases",
    editList("Rules for borderline cases, one per line", k.edgeCases, touch, {
      wide: true,
      placeholder: "e.g. “Mentions quitting hypothetically (‘if things don't change…’) → code as absent.”",
    })));

  /* worked examples */
  k.examples = k.examples ?? [];
  const exTable = examplesTable(k, touch);
  redrawExamples = exTable.redraw;
  pane.append(section("Worked examples",
    el("p", { class: "screen__hint faint" },
      "Sent to the coder word for word as text → label pairs. Label = the correct answer, exactly as the coder should give it. Kind: positive = a clear case · nearmiss = borderline, the label shows which side of the line · negative = looks relevant but does not qualify, the label carries the correct answer."),
    exTable.node));

  if (dirty) saveBtn.disabled = false;
}

function editList(label, arr, touch, { wide = false, placeholder = null } = {}) {
  const listEl = el("ul", { class: `editlist${wide ? " editlist--wide" : ""}`, role: "list" });
  const redraw = () => {
    clear(listEl);
    arr.forEach((item, i) => {
      listEl.append(el("li", { class: "editlist__row" },
        el("textarea", {
          class: "input editlist__input", rows: 1, "aria-label": `${label} ${i + 1}`,
          placeholder,
          oninput: (e) => { arr[i] = e.target.value; touch(); },
        }, item),
        el("button", {
          class: "btn btn--quiet editlist__remove", type: "button", aria: { label: "Remove" },
          onclick: () => { arr.splice(i, 1); touch(); redraw(); },
        }, "×")));
    });
    listEl.append(el("li", {},
      el("button", {
        class: "btn btn--quiet", type: "button",
        onclick: () => { arr.push(""); touch(); redraw(); },
      }, "+ add")));
  };
  redraw();
  return el("div", { class: "editlist__wrap" },
    el("h4", { class: "editlist__label" }, label),
    listEl);
}

function categoriesEditor(k, touch) {
  const wrap = el("ol", { class: "catlist", role: "list" });
  const redraw = () => {
    clear(wrap);
    k.categories.forEach((cat, i) => {
      wrap.append(el("li", { class: "catrow" },
        el("kbd", { class: "catrow__key", title: "Coding-sprint key" }, String(i + 1)),
        el("input", {
          class: "input catrow__label", value: cat.label ?? cat.value, "aria-label": `Category ${i + 1} label`,
          placeholder: "label — e.g. Severe",
          oninput: (e) => { cat.label = e.target.value; touch(); },
        }),
        el("input", {
          class: "input catrow__anchor", value: cat.anchor ?? "",
          placeholder: "what this pole means — e.g. “depletion, health language, ‘nothing left’”",
          "aria-label": `Category ${i + 1} anchor`,
          oninput: (e) => { cat.anchor = e.target.value; touch(); },
        }),
        el("span", { class: "catrow__move" },
          el("button", {
            class: "btn btn--quiet", type: "button", aria: { label: `Move ${cat.label} up` }, disabled: i === 0,
            onclick: () => { [k.categories[i - 1], k.categories[i]] = [k.categories[i], k.categories[i - 1]]; touch(); redraw(); },
          }, "↑"),
          el("button", {
            class: "btn btn--quiet", type: "button", aria: { label: `Move ${cat.label} down` }, disabled: i === k.categories.length - 1,
            onclick: () => { [k.categories[i + 1], k.categories[i]] = [k.categories[i], k.categories[i + 1]]; touch(); redraw(); },
          }, "↓")),
        el("button", {
          class: "btn btn--quiet", type: "button", aria: { label: `Remove ${cat.label}` },
          onclick: () => { k.categories.splice(i, 1); touch(); redraw(); },
        }, "×"),
      ));
    });
    wrap.append(el("li", { class: "catrow catrow--add" },
      el("button", {
        class: "btn btn--quiet", type: "button",
        onclick: () => {
          k.categories.push({ value: `cat${k.categories.length + 1}`, label: "", anchor: "" });
          touch(); redraw();
        },
      }, "+ add category")));
  };
  redraw();
  return wrap;
}

function examplesTable(k, touch) {
  const wrap = el("div", { class: "exwrap" });

  // The label control follows the construct's answer space: categories → a
  // picker (multilabel: toggle every category that applies), continuous → a
  // number, otherwise text. Free text here invites labels no coder is
  // allowed to answer with.
  const labelField = (ex, i, redraw) => {
    const cats = k.categories ?? null;
    if (cats && k.type === "multilabel") {
      const current = Array.isArray(ex.label) ? ex.label : (ex.label == null || ex.label === "" ? [] : [ex.label]);
      return el("span", { class: "kindchips", role: "group", aria: { label: `Example ${i + 1} labels — every category that applies` } },
        ...cats.map((c) => {
          const on = current.includes(c.value);
          return el("button", {
            class: `chip kindchip${on ? " kindchip--on" : ""}`,
            type: "button", "aria-pressed": on ? "true" : "false",
            title: `stored as ${JSON.stringify(c.value)}`,
            onclick: () => {
              ex.label = on ? current.filter((v) => v !== c.value) : [...current, c.value];
              touch(); redraw();
            },
          }, c.label);
        }));
    }
    if (cats) {
      const empty = ex.label == null || ex.label === "";
      const known = !empty && cats.some((c) => c.value === ex.label);
      return el("select", {
        class: "input extable__labelpick", "aria-label": `Example ${i + 1} label`,
        onchange: (e) => {
          // option values are DOM strings — resolve back to the ORIGINAL
          // category value so numeric labels keep their type (the answer
          // schema wants 2, not "2")
          const hit = cats.find((c) => String(c.value) === e.target.value);
          ex.label = hit ? hit.value : e.target.value;
          touch();
        },
      },
        ...(empty ? [el("option", { value: "", selected: true, disabled: true }, "pick its correct label")] : []),
        ...(!empty && !known ? [el("option", { value: String(ex.label), selected: true }, `${String(ex.label)} — not a current category`)] : []),
        ...cats.map((c) => el("option", { value: c.value, selected: ex.label === c.value, title: `stored as ${JSON.stringify(c.value)}` }, c.label)));
    }
    if (k.type === "continuous") {
      return el("input", {
        class: "input extable__labelpick", type: "number", value: ex.label ?? "",
        ...(k.scale != null ? { min: k.scale.min, max: k.scale.max, placeholder: `${k.scale.min}–${k.scale.max}` } : { placeholder: "number" }),
        "aria-label": `Example ${i + 1} label`,
        oninput: (e) => { ex.label = e.target.value === "" ? "" : Number(e.target.value); touch(); },
      });
    }
    return el("input", {
      class: "input extable__labelpick", value: ex.label ?? "", "aria-label": `Example ${i + 1} label`,
      placeholder: k.type === "extraction" ? "the exact span(s) the coder should extract" : "the correct answer — e.g. yes",
      oninput: (e) => { ex.label = e.target.value; touch(); },
    });
  };

  const redraw = () => {
    clear(wrap);
    const tbl = el("table", { class: "table extable" },
      el("caption", { class: "sr-only" }, "Worked examples"),
      el("thead", {}, el("tr", {},
        el("th", { scope: "col" }, "Example text"),
        el("th", { scope: "col" }, "Label"),
        el("th", { scope: "col" }, "Kind"),
        el("th", { scope: "col" }, ""))),
      el("tbody", {},
        ...k.examples.map((ex, i) =>
          el("tr", {},
            el("td", { class: "extable__text" },
              el("textarea", {
                class: "input extable__input", rows: 2, "aria-label": `Example ${i + 1} text`,
                placeholder: "paste a real unit — e.g. “Base salary sat 18% under market and the refresh grants never came.”",
                oninput: (e) => { ex.text = e.target.value; touch(); },
              }, ex.text ?? "")),
            el("td", {}, labelField(ex, i, redraw)),
            el("td", {},
              el("span", { class: "kindchips", role: "radiogroup", aria: { label: `Example ${i + 1} kind` } },
                ...KINDS.map((kind) =>
                  el("button", {
                    class: `chip kindchip kindchip--${kind}${ex.kind === kind ? " kindchip--on" : ""}`,
                    type: "button",
                    title: KIND_HELP[kind],
                    "aria-pressed": ex.kind === kind ? "true" : "false",
                    onclick: () => { ex.kind = kind; touch(); redraw(); },
                  }, kind)))),
            el("td", {},
              el("button", {
                class: "btn btn--quiet", type: "button", aria: { label: "Remove example" },
                onclick: () => { k.examples.splice(i, 1); touch(); redraw(); },
              }, "×")),
          ))),
    );
    wrap.append(tbl,
      el("button", {
        class: "btn btn--quiet", type: "button",
        onclick: () => { k.examples.push({ text: "", label: "", kind: "positive" }); touch(); redraw(); },
      }, "+ add example"));
  };
  redraw();
  return { node: wrap, redraw };
}

/* ---- write your own: name + type, then straight into the editor ----------------- */

// The minimal hand-authoring door (POST constructs needs only name + type).
// Definition, criteria, categories and examples are the editor's job — this
// sheet exists so "write your own" has a path that is not proposal Accept.
function newConstruct(params) {
  const s = openSheet({ title: "New construct", overline: "Codebook" });
  let type = "binary";
  const nameInput = el("input", {
    class: "input", "aria-label": "Construct name",
    placeholder: "e.g. Compensation grievance",
  });
  const typeSel = el("select", {
    class: "input", "aria-label": "Construct type",
    onchange: (e) => { type = e.target.value; },
  }, ...TYPES.map((t) => el("option", { value: t, selected: t === type }, t)));
  s.body.append(
    el("p", {}, "Name the thing you want to measure and pick its answer type. The construct opens in the editor, where the definition, criteria, categories and worked examples are written."),
    el("label", { class: "field" }, el("span", { class: "field__label overline" }, "Name"), nameInput),
    el("label", { class: "field" }, el("span", { class: "field__label overline" }, "Type"), typeSel),
  );
  const createBtn = el("button", {
    class: "btn btn--primary", type: "button",
    onclick: async (e) => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      e.target.disabled = true;
      try {
        const created = await api.constructs.create(params.slug, { name, type });
        toast.success(`Construct “${created.name}” created.`, { detail: "write its definition and criteria, then save" });
        s.close();
        router.navigate(`p/${params.slug}/constructs/${created.id}`);
      } catch (err) {
        e.target.disabled = false;
        toast.error("Could not create the construct.", { detail: String(err.message ?? err) });
      }
    },
  }, "Create and open the editor");
  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    createBtn,
  );
  nameInput.focus();
}

/* ---- flows: draft / import / inductive --------------------------------------------- */

// Live contracts:
//   POST constructs/draft {input, corpusId?} → {constructs: proposals[],
//     sampleN} — un-persisted, full construct proposals formalizing the
//     USER's concepts; accepting persists through POST constructs.
//   POST constructs/inductive → a TAXONOMY artifact {mode:
//     "inductive-hypothesis", corpusId, sampleN, themes: [{name, definition,
//     quoteRefs}], note, issues: {invalidRefs}, …} — themes, not constructs.
//   POST constructs/import (multipart) → {constructs: Construct[], proposed:
//     true} — full director-authored construct proposals.
//   POST constructs accepts a full construct body (name + type required).

// ONE Director sheet at a time. Clicking a header button while a call is in
// flight refocuses the open sheet (or says the call is still running if the
// sheet was closed) instead of stacking a second sheet / second spend.
let activeDirector = null; // {kind, busy(), sheetOpen(), focus(), close()}

// activeDirector is module-scoped, so a sheet left open when the user
// navigates away would otherwise wedge: returning and clicking "Draft with
// Director" refocuses the orphaned (now-removed) sheet. The sheet itself
// closes on route change (openSheet subscribes), but that fires onClose ~350ms
// later; clear the handle synchronously here so a fast return-and-click starts
// fresh. An in-flight call still settles through its own then/catch.
bus.on("route:changed", () => { activeDirector = null; });

function guardDirector(kind) {
  if (!activeDirector) return false;
  if (activeDirector.busy()) {
    if (activeDirector.sheetOpen()) activeDirector.focus();
    else toast.info("The Director is still working on the last request.", {
      detail: "the proposals appear automatically when the Director finishes; you do not need to click again",
    });
    return true;
  }
  if (activeDirector.kind === kind) { // same sheet already open — refocus it
    activeDirector.focus();
    return true;
  }
  activeDirector.close(); // idle sheet of the other kind — swap, don't stack
  return false;
}

/** Re-resolve the route so newly accepted constructs appear in the list. */
function repaintConstructs() {
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function draftWithDirector(params) {
  if (guardDirector("draft")) return;
  let inFlight = false;
  let sheetOpen = true;
  let stopBusy = null;

  const s = openSheet({
    title: "Draft with the Director", overline: "Your concepts → draft constructs",
    onClose: () => {
      sheetOpen = false;
      stopBusy?.();
      if (inFlight) {
        toast.info("Hidden — the draft keeps running.", {
          detail: "the proposals sheet appears automatically when the Director finishes; you do not need to click again",
        });
      } else if (activeDirector?.kind === "draft") activeDirector = null;
    },
  });

  const input = el("textarea", {
    class: "input textarea", rows: 5, "aria-label": "Concepts to draft",
    placeholder: "One concept per line (name: optional hint):\nburnout: exhaustion the respondent attributes to their own workload\nmanager support: blame or praise aimed at the direct manager\nOr type one research question alone on a single line, e.g. Which exits were preventable?",
  });
  // the draft reads the project's FIRST corpus (no picker exists) — name it
  // so a multi-corpus project knows which one feeds the worked examples
  const draftCorpus = (store.get("project")?.corpora ?? [])[0] ?? null;
  s.body.append(
    el("p", {},
      "Write the concepts ", el("strong", {}, "you"), " want to measure. The Director reads a sample of up to 60 units from ",
      draftCorpus ? el("span", { class: "data" }, scopechip.displayName(draftCorpus)) : "the project corpus",
      " and returns a full draft construct for each — definition, include/exclude criteria, worked examples. One Director call, usually 30–60 seconds; nothing is saved until you accept a proposal."),
    el("label", { class: "field" },
      el("span", { class: "field__label overline" }, "Concepts"),
      input),
    el("p", { class: "screen__hint faint" },
      "Drafting formalizes your concepts. To have the Director propose themes ",
      el("em", {}, "from the corpus"), " instead, use Inductive mode — that is hypothesis generation and is labeled as such."),
  );

  const paintFoot = () => {
    runBtn.disabled = false;
    s.foot.replaceChildren(
      el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
      runBtn);
  };
  const runBtn = el("button", {
    class: "btn btn--primary", type: "button",
    onclick: async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      inFlight = true;
      stopBusy = sheetBusy(s, runBtn, {
        label: (sec) => `Drafting constructs · ${sec}s`,
        hint: "reading a 60-unit sample — one Director call, ~30–60 s on flash-class models",
      });
      try {
        const res = await api.constructs.draft(params.slug, { input: text });
        inFlight = false;
        stopBusy?.();
        activeDirector = null;
        if (sheetOpen) s.close();
        // origin: "draft" — accept persists it, so the methods text can say
        // the entry formalized the researcher's concepts (vs inductive mining)
        proposalsSheet(params, (res?.constructs ?? []).map((c) => ({ ...c, origin: "draft" })),
          "Director draft — your concepts, formalized",
          { sampleN: res?.sampleN });
      } catch (err) {
        inFlight = false;
        stopBusy?.();
        toast.error("The draft failed.", { detail: String(err.message ?? err) });
        if (sheetOpen) paintFoot();
        else activeDirector = null;
      }
    },
  }, "Draft constructs");
  paintFoot();

  activeDirector = {
    kind: "draft",
    busy: () => inFlight,
    sheetOpen: () => sheetOpen,
    focus: () => s.el.querySelector("textarea, button:not(.sheet__close)")?.focus(),
    close: () => s.close(),
  };
}

function importCodebook(params) {
  const picker = el("input", {
    type: "file", accept: ".docx,.pdf", class: "sr-only",
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      toast.info("Reading the codebook…", { detail: file.name, data: true });
      try {
        const res = await api.constructs.importFile(params.slug, file);
        proposalsSheet(params, res?.constructs ?? [], `Imported from ${file.name}`);
      } catch (err) {
        toast.error("Codebook import failed.", { detail: String(err.message ?? err) });
      }
    },
  });
  document.body.append(picker);
  picker.click();
  setTimeout(() => picker.remove(), 60000);
}

function inductiveMode(params) {
  if (guardDirector("inductive")) return;
  let inFlight = false;
  let sheetOpen = true;
  let stopBusy = null;

  const s = openSheet({
    title: "Inductive mode", overline: "Hypothesis generation — labeled as such",
    onClose: () => {
      sheetOpen = false;
      stopBusy?.();
      if (inFlight) {
        toast.info("Hidden — the inductive pass keeps running.", {
          detail: "the proposals sheet appears automatically when the Director finishes; you do not need to click again",
        });
      } else if (activeDirector?.kind === "inductive") activeDirector = null;
    },
  });

  // the pass reads the project's FIRST corpus (no picker exists) — name it
  // so a multi-corpus project knows which one is being themed
  const inductiveCorpus = (store.get("project")?.corpora ?? [])[0] ?? null;
  s.body.append(
    el("p", {},
      "The Director reads up to 200 units from ",
      inductiveCorpus ? el("span", { class: "data" }, scopechip.displayName(inductiveCorpus)) : "the project corpus",
      " with no codebook and proposes a taxonomy of candidate themes. One Director call, usually 30–90 seconds; you review every proposal before anything is saved."),
    el("p", { class: "screen__hint" },
      "Inductive output is ", el("strong", {}, "hypothesis generation, not measurement"),
      " — proposals arrive exploratory and Director-marked; the methods text records that the Director drafted them. To formalize concepts you already have, use Draft with Director instead."),
  );

  const paintFoot = () => {
    runBtn.disabled = false;
    s.foot.replaceChildren(
      el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
      runBtn);
  };
  const runBtn = el("button", {
    class: "btn btn--primary", type: "button",
    onclick: async () => {
      inFlight = true;
      stopBusy = sheetBusy(s, runBtn, {
        label: (sec) => `Running the inductive pass · ${sec}s`,
        hint: "reading a 200-unit sample — one Director call, ~30–90 s on flash-class models",
      });
      try {
        const taxonomy = await api.constructs.inductive(params.slug, { n: 200 });
        inFlight = false;
        stopBusy?.();
        activeDirector = null;
        if (sheetOpen) s.close();
        themesSheet(params, taxonomy, "Inductive proposals — hypotheses to review");
      } catch (err) {
        inFlight = false;
        stopBusy?.();
        toast.error("Inductive pass failed.", { detail: String(err.message ?? err) });
        if (sheetOpen) paintFoot();
        else activeDirector = null;
      }
    },
  }, "Run the inductive pass");
  paintFoot();

  activeDirector = {
    kind: "inductive",
    busy: () => inFlight,
    sheetOpen: () => sheetOpen,
    focus: () => s.el.querySelector("button:not(.sheet__close)")?.focus(),
    close: () => s.close(),
  };
}

/* Inductive taxonomy → review sheet. Accepting a theme materializes a binary
   draft construct (present/absent) seeded from the theme's definition. */
function themesSheet(params, taxonomy, titleLine) {
  const themes = taxonomy?.themes ?? [];
  const proposals = themes.map((t) => ({
    name: t.name,
    type: "binary",
    definition: t.definition ?? "",
    criteria: { include: [], exclude: [] },
    edgeCases: [],
    examples: [],
    categories: [{ value: "present", label: "Present" }, { value: "absent", label: "Absent" }],
    // provenance: the corpus the taxonomy was themed from — accept persists
    // it as draftedFrom, same field the draft flow stamps server-side —
    // plus origin: "inductive" so the methods text states the construct came
    // from a corpus-mining pass, not from the researcher's own concepts
    ...(taxonomy?.corpusId ? { draftedFrom: taxonomy.corpusId } : {}),
    origin: "inductive",
    quoteRefs: t.quoteRefs ?? [],
  }));
  proposalsSheet(params, proposals, titleLine, {
    note: taxonomy?.note,
    sampleN: taxonomy?.sampleN,
  });
}

function proposalsSheet(params, proposals, titleLine, { note, sampleN } = {}) {
  let accepted = 0;
  const s = openSheet({
    title: titleLine, overline: "Review proposals", wide: true,
    // however the sheet closes (Done, ×, Esc, scrim), accepted constructs
    // must already be on the screen behind it — never a silent dead-end
    onClose: () => { if (accepted > 0) repaintConstructs(); },
  });
  if (sampleN) {
    s.body.append(el("p", { class: "faint screen__hint" },
      `Read from a ${sampleN}-unit sample. `, note ?? ""));
  }
  if (!proposals.length) {
    s.body.append(el("p", { class: "faint" }, "No proposals came back. Try more specific concepts, or check the Director model in Settings."));
  } else {
    s.body.append(el("p", { class: "screen__hint" },
      "Accept adds a proposal to your codebook immediately (it appears in the list behind this sheet); Dismiss drops it. Accepted constructs stay editable — open one to refine its definition and criteria."));
  }
  for (const prop of proposals) {
    const { quoteRefs, ...constructBody } = prop;
    const row = el("div", { class: "proposal" },
      el("div", { class: "proposal__text" },
        el("h3", { class: "proposal__name" }, prop.name, glyph.render({ authoredBy: "director", humanTouched: false })),
        el("p", { class: "proposal__def" }, prop.definition),
        el("p", { class: "proposal__meta" },
          el("span", { class: "chip" }, prop.type),
          ...(prop.categories ?? []).map((c) => el("span", { class: "chip" }, c.label ?? String(c.value))),
          ...(quoteRefs ?? []).slice(0, 4).map((id) =>
            el("button", { class: "refchip data evidence-door", type: "button", dataset: { evidence: id } }, String(id).slice(0, 8) + "…"))),
        prop.examples?.length
          ? quotecard.render({ unit: { id: prop.examples[0].unitId ?? "example", text: prop.examples[0].text }, compact: true })
          : null),
      el("div", { class: "proposal__actions" },
        el("button", {
          class: "btn btn--primary", type: "button",
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const created = await api.constructs.create(params.slug, { ...constructBody, authoredBy: "director", humanTouched: false });
              accepted += 1;
              toast.success(`Accepted “${created.name}” — it is in your codebook now.`, { detail: "open it from the list to edit; editing marks it as yours" });
              row.classList.add("proposal--accepted");
              e.target.textContent = "Accepted";
              repaintConstructs(); // the list behind the sheet updates now
            } catch (err) {
              e.target.disabled = false;
              toast.error("Could not accept.", { detail: String(err.message ?? err) });
            }
          },
        }, "Accept"),
        el("button", { class: "btn btn--quiet", type: "button", onclick: () => row.remove() }, "Dismiss")),
    );
    s.body.append(row);
  }
  s.foot.append(el("button", {
    class: "btn", type: "button",
    onclick: () => {
      s.close();
      router.navigate(`p/${params.slug}/constructs`);
      // same-hash navigation does not fire hashchange — nudge the router
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    },
  }, "Done"));
}
