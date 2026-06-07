// Scope chip — the one-line answer to "which column, which rows, what's
// excluded?" that every analysis surface wears. Renders a compact inline
// strip: `Text: response · 2,500 units · 85 junk-flagged (included) ·
// 6 metadata columns`, plus `derived from <corpus>` when the corpus was
// re-unitized. When an operation considers ALL metadata columns (the Brief's
// metadata summarization), pass {allMeta: true} and the chip says so.
//
// Tolerant of pre-scope artifacts: a null textColumn renders as
// "text column not recorded" rather than guessing; null junk/metaColumns
// segments are simply omitted.
//
//   render({ textColumn, scheme, unitCount, junk, metaColumns, derivedFrom,
//            allMeta }) → <p class="scopechip">
//   fromCorpus(corpusEntry, project) → props | null — normalizes both the
//     new corpus shape ({textColumn, scheme, junk, metaColumns, sourceName,
//     derivedFrom?}) and older entries (unitization.{textColumn, scheme}).
//   displayName(corpus) → the corpus name WITHOUT a trailing "· text=<col>"
//     when that column is the corpus's own text column — re-unitized names
//     carry the suffix, and every structured label here states the column
//     again, so keeping both would say the same thing twice.

import { el } from "../dom.js";
import { fmtCount } from "../format.js";

/** Display name for a corpus entry. Re-unitization names a derived corpus
    `<source name> · text=<col>`; when that col IS the entry's text column the
    suffix is redundant beside any structured `text: <col>` segment, so it is
    stripped for display. The stored name is never touched. */
export function displayName(corpus) {
  if (!corpus) return "";
  const name = String(corpus.name ?? corpus.id ?? "");
  const textColumn = corpus.textColumn ?? corpus.unitization?.textColumn ?? null;
  if (!textColumn) return name;
  const m = name.match(/^(.*?)\s*·\s*text=(.+)$/);
  if (m && m[2].trim() === String(textColumn) && m[1].trim()) return m[1].trim();
  return name;
}

/** Resolve a derivedFrom ref ({id, name} | corpusId string) to a display name. */
export function resolveDerived(ref, project = null) {
  if (!ref) return null;
  if (typeof ref === "object") return ref.name ?? ref.id ?? null;
  const src = (project?.corpora ?? []).find((c) => c.id === ref);
  if (!src) return String(ref);
  return src.sourceName ?? (displayName(src) || String(ref));
}

/** One-line corpus label for pickers: `name — text: <col> · 1,234 units`. */
export function optionLabel(corpus, project = null) {
  if (!corpus) return "";
  const p = fromCorpus(corpus, project);
  const units = p.unitCount !== null && p.unitCount !== undefined
    ? ` · ${fmtCount(p.unitCount)} units` : "";
  return `${displayName(corpus)} — text: ${p.textColumn ?? "not recorded"}${units}`;
}

/** Normalize a project corpus entry (new or old shape) into render() props. */
export function fromCorpus(corpus, project = null) {
  if (!corpus) return null;
  return {
    textColumn: corpus.textColumn ?? corpus.unitization?.textColumn ?? null,
    scheme: corpus.scheme ?? corpus.unitization?.scheme ?? null,
    unitCount: corpus.unitCount ?? null,
    junk: corpus.junk ?? null,
    metaColumns: corpus.metaColumns ?? null,
    derivedFrom: resolveDerived(corpus.derivedFrom, project),
    sourceName: corpus.sourceName ?? (displayName(corpus) || null),
  };
}

export function render({
  textColumn = null, scheme = null, unitCount = null, junk = null,
  metaColumns = null, derivedFrom = null, allMeta = false,
} = {}) {
  const segs = [];

  /* which column */
  if (textColumn) {
    segs.push(el("span", {
      class: "scopechip__seg",
      title: `Unit text reads from “${textColumn}”${scheme ? ` (${scheme} unitization)` : ""}`,
    },
      el("span", { class: "scopechip__key" }, "Text: "),
      el("span", { class: "scopechip__val data" }, textColumn)));
  } else {
    segs.push(el("span", {
      class: "scopechip__seg scopechip__seg--warn",
      title: "This corpus predates scope tracking. Re-import it, or set the unit text column from its Instant Read (this builds a recorded, derived copy).",
    }, "text column not recorded"));
  }

  /* which rows */
  if (unitCount !== null && unitCount !== undefined) {
    segs.push(el("span", {
      class: "scopechip__seg",
      title: scheme ? `${scheme} unitization — one unit per ${scheme}` : null,
    }, el("span", { class: "data" }, fmtCount(unitCount)), " units"));
  }

  /* what's excluded — nothing silently; junk is flagged, never dropped */
  if (junk && typeof junk === "object") {
    const total = Object.values(junk).reduce((s, n) => s + (Number(n) || 0), 0);
    const breakdown = Object.entries(junk)
      .filter(([, n]) => Number(n) > 0)
      .map(([kind, n]) => `${kind} ${fmtCount(n)}`)
      .join(" · ");
    segs.push(el("span", {
      class: "scopechip__seg",
      title: total > 0
        ? `${breakdown} — flagged at import and kept in the corpus; Concord never drops units — to remove them, clean the source file and re-import`
        : "no units flagged as junk",
    }, el("span", { class: "data" }, fmtCount(total)), " junk-flagged (included)"));
  }

  /* which metadata columns ride along — and whether ALL are considered */
  const metaCount = Array.isArray(metaColumns) ? metaColumns.length
    : (typeof metaColumns === "number" ? metaColumns : null);
  const metaNames = Array.isArray(metaColumns) ? metaColumns.join(", ") : null;
  if (metaCount !== null) {
    segs.push(el("span", {
      class: "scopechip__seg",
      title: metaNames
        ? (allMeta ? `All metadata columns are considered: ${metaNames}` : `Metadata columns: ${metaNames}`)
        : null,
    },
      allMeta ? "all " : null,
      el("span", { class: "data" }, fmtCount(metaCount)),
      allMeta ? " metadata columns considered" : " metadata columns"));
  } else if (allMeta) {
    segs.push(el("span", { class: "scopechip__seg" }, "all metadata columns considered"));
  }

  /* provenance of a re-unitized corpus */
  if (derivedFrom) {
    segs.push(el("span", {
      class: "scopechip__seg",
      title: "Re-unitized from another corpus; the original is kept unchanged",
    }, "derived from ", el("span", { class: "data" }, String(derivedFrom))));
  }

  return el("p", { class: "scopechip", role: "note", aria: { label: "Analysis scope" } }, ...segs);
}
