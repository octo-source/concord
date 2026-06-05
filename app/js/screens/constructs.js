// Constructs — #/p/:slug/constructs[/:id] — the codebook. A list pane and a
// structured editor: definition, include/exclude criteria, edge cases,
// categories with EXPLICIT order (order feeds ordinal statistics), and a
// worked-examples table with kind chips. Director-authored constructs wear
// the glyph until the first human edit lands (humanTouched PUT) — then it
// dissolves. Draft with Director, import a legacy codebook (proposals →
// accept), or enter inductive mode (labeled as hypothesis generation).

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as glyph from "../components/glyph.js";
import * as quotecard from "../components/quotecard.js";
import { screenHead, section, asyncMount, ensureProject, emptyState, openSheet } from "./_shared.js";

export const route = "p/:slug/constructs";
export const routes = ["p/:slug/constructs", "p/:slug/constructs/:id"];
export const title = "Constructs";

const KINDS = ["positive", "negative", "nearmiss"];
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
      lede: "What you are measuring, stated precisely enough that a stranger — or a model — could apply it.",
      actions: [
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
      }));
    } else {
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

  const saveBtn = el("button", {
    class: "btn btn--primary", type: "button", disabled: !dirty,
    onclick: async () => {
      saveBtn.disabled = true;
      try {
        await api.constructs.update(params.slug, k.id, k);
        toast.success("Construct saved.", { detail: k.humanTouched && construct.authoredBy === "director" && !construct.humanTouched ? "adopted — the Director's glyph dissolves" : k.id, data: true });
        dirty = false;
      } catch (err) {
        saveBtn.disabled = false;
        toast.error("Save failed.", { detail: String(err.message ?? err) });
      }
    },
  }, "Save");

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
        onchange: (e) => { k.type = e.target.value; touch(); },
      }, ...TYPES.map((t) => el("option", { value: t, selected: t === k.type }, t))),
      saveBtn),
  ));

  /* definition */
  pane.append(section("Definition",
    el("textarea", {
      class: "input textarea", rows: 3, "aria-label": "Definition",
      value: k.definition ?? "",
      oninput: (e) => { k.definition = e.target.value; touch(); },
    }, k.definition ?? "")));

  /* criteria */
  const criteria = k.criteria ?? (k.criteria = { include: [], exclude: [] });
  pane.append(section("Criteria",
    el("div", { class: "twocol" },
      editList("Include when…", criteria.include, touch),
      editList("Exclude when…", criteria.exclude, touch))));

  /* categories with order */
  if (k.categories) {
    pane.append(section("Categories — order matters",
      el("p", { class: "screen__hint faint" }, "This order feeds ordinal statistics (weighted κ, ordinal α) and sets the coding-sprint number keys."),
      categoriesEditor(k, touch)));
  }

  /* edge cases */
  k.edgeCases = k.edgeCases ?? [];
  pane.append(section("Edge cases", editList("The hard calls, written down", k.edgeCases, touch, { wide: true })));

  /* worked examples */
  k.examples = k.examples ?? [];
  pane.append(section("Worked examples", examplesTable(k, touch)));

  if (dirty) saveBtn.disabled = false;
}

function editList(label, arr, touch, { wide = false } = {}) {
  const listEl = el("ul", { class: `editlist${wide ? " editlist--wide" : ""}`, role: "list" });
  const redraw = () => {
    clear(listEl);
    arr.forEach((item, i) => {
      listEl.append(el("li", { class: "editlist__row" },
        el("textarea", {
          class: "input editlist__input", rows: 1, "aria-label": `${label} ${i + 1}`,
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
          oninput: (e) => { cat.label = e.target.value; touch(); },
        }),
        el("input", {
          class: "input catrow__anchor", value: cat.anchor ?? "", placeholder: "anchor — what this pole means",
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
                oninput: (e) => { ex.text = e.target.value; touch(); },
              }, ex.text ?? "")),
            el("td", {},
              el("input", {
                class: "input", value: ex.label ?? "", "aria-label": `Example ${i + 1} label`,
                oninput: (e) => { ex.label = e.target.value; touch(); },
              })),
            el("td", {},
              el("span", { class: "kindchips", role: "radiogroup", aria: { label: `Example ${i + 1} kind` } },
                ...KINDS.map((kind) =>
                  el("button", {
                    class: `chip kindchip kindchip--${kind}${ex.kind === kind ? " kindchip--on" : ""}`,
                    type: "button",
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
  return wrap;
}

/* ---- flows: draft / import / inductive --------------------------------------------- */

// Live contracts:
//   POST constructs/inductive → a TAXONOMY artifact {mode:
//     "inductive-hypothesis", corpusId, sampleN, themes: [{name, definition,
//     quoteRefs}], note, issues: {invalidRefs}, …} — themes, not constructs.
//   POST constructs/import (multipart) → {constructs: Construct[], proposed:
//     true} — full director-authored construct proposals.
//   POST constructs accepts a full construct body (name + type required).

function draftWithDirector(params) {
  const s = openSheet({ title: "Draft with the Director", overline: "Suggestion mode" });
  s.body.append(
    el("p", { class: "screen__hint" }, "The Director reads a corpus sample and sketches candidate themes — definition and anchoring quotes each. A theme you accept becomes a draft construct wearing ", el("span", { class: "dglyph__mark" }, glyph.GLYPH), " until you edit or adopt it."),
  );
  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const taxonomy = await api.constructs.inductive(params.slug, { n: 60 });
          s.close();
          themesSheet(params, taxonomy, "Director draft");
        } catch (err) {
          e.target.disabled = false;
          toast.error("The Director could not draft.", { detail: String(err.message ?? err) });
        }
      },
    }, "Draft"),
  );
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
  const s = openSheet({ title: "Inductive mode", overline: "Hypothesis generation — labeled as such" });
  s.body.append(
    el("p", {}, "The Director reads a sample with no codebook and proposes a taxonomy of what it finds. Inductive output is ", el("strong", {}, "hypothesis generation, not measurement"), " — every proposal arrives exploratory and Director-glyphed, and the methods text will say where it came from."),
    el("p", { class: "screen__hint faint" }, "Sample: 200 units."),
  );
  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const taxonomy = await api.constructs.inductive(params.slug, { n: 200 });
          s.close();
          themesSheet(params, taxonomy, "Inductive proposals");
        } catch (err) {
          e.target.disabled = false;
          toast.error("Inductive pass failed.", { detail: String(err.message ?? err) });
        }
      },
    }, "Run the inductive pass"),
  );
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
    quoteRefs: t.quoteRefs ?? [],
  }));
  proposalsSheet(params, proposals, titleLine, {
    note: taxonomy?.note,
    sampleN: taxonomy?.sampleN,
  });
}

function proposalsSheet(params, proposals, titleLine, { note, sampleN } = {}) {
  const s = openSheet({ title: titleLine, overline: "Review proposals", wide: true });
  if (sampleN) {
    s.body.append(el("p", { class: "faint screen__hint" },
      `Read from a ${sampleN}-unit sample. `, note ?? ""));
  }
  if (!proposals.length) {
    s.body.append(el("p", { class: "faint" }, "No proposals came back."));
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
              toast.success(`Accepted “${created.name}”.`, { detail: "it keeps the Director's glyph until you edit it" });
              row.classList.add("proposal--accepted");
              e.target.textContent = "Accepted";
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
