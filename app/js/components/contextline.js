// Context line — the one line under a screen head where an object states its
// relationships: what it measures, what it reads, what it was drafted from.
// ONE shared helper so the pattern cannot drift across screens.
//
//   contextLine([{label, text, href?, node?, faint?}, …]) → <p class="contextline">
//
//   label  overline voice ("measures", "reads", "ran", "gold for", …)
//   text   the related object's display text; with `href` it renders as a
//          link with a trailing →
//   node   a prepared Node instead of text (e.g. the corpus <select> in the
//          instrument editor, or a list of instrument links) — same slot,
//          same rhythm
//   faint  render the text quiet (legacy objects whose relation is unknown)
//
// Null/undefined parts are skipped, so screens can write conditionals inline.
// corpusText() is the standard corpus rendering for these lines — it defers
// to scopechip.optionLabel ("name — text: col · 1,234 units") so the corpus
// facts read identically everywhere.

import { el } from "../dom.js";
import * as scopechip from "./scopechip.js";

/** "corpus — text: col · n units" | honest fallback for missing entries. */
export function corpusText(corpus, project = null, missingId = null) {
  if (corpus) return scopechip.optionLabel(corpus, project);
  if (missingId) return `${missingId} — corpus no longer in this project`;
  return "corpus not recorded";
}

export function contextLine(parts = []) {
  const segs = [];
  for (const part of parts) {
    if (!part) continue;
    const body = part.node
      ? part.node
      : part.href
        ? el("a", { class: "contextline__link", href: part.href }, part.text, " →")
        : el("span", { class: `contextline__text${part.faint ? " faint" : ""}` }, part.text);
    segs.push(el("span", { class: "contextline__seg" },
      part.label ? el("span", { class: "overline contextline__label" }, part.label, " ") : null,
      body));
  }
  return el("p", { class: "contextline", role: "note", aria: { label: "Context" } }, ...segs);
}
