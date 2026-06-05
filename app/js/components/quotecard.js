// Verbatim quote block — the human voice in the reading room. Set in
// Fraunces with a hanging quote glyph so machine prose can never be mistaken
// for a person. Source line in mono beneath. Dictionary hits render as
// category-tinted <mark> spans built from offsets (text nodes throughout —
// corpus text is never injected as HTML).

import { el } from "../dom.js";

/**
 * render({ unit, highlights, gold, lang, anonymized, compact, evidence })
 *   unit        { id, text, meta?, pos? }
 *   highlights  [{ start, end, category?, kind?: "dict"|"pii" }] — offsets
 *               into unit.text; overlaps are clamped, out-of-range dropped
 *   gold        gold-standard label to show as a gold chip (human encoding)
 *   lang        BCP-47 tag for the quote text (Spanish verbatims hyphenate
 *               and read aloud correctly)
 *   anonymized  true → "pseudonymized" chip on the source line
 *   compact     tighter variant for result lists
 *   evidence    true → the card itself opens the inspector (data-evidence)
 * → <figure class="quote">
 */
export function render({
  unit = {},
  highlights = [],
  gold = undefined,
  lang = undefined,
  anonymized = false,
  compact = false,
  evidence = false,
} = {}) {
  const text = String(unit.text ?? "");

  const body = el("blockquote", {
    class: "quote__text",
    lang: lang || undefined,
  }, ...renderSpans(text, highlights));

  const source = el("figcaption", { class: "quote__source data" },
    unit.id ? el("span", { class: "quote__id" }, unit.id) : null,
    ...posChips(unit.pos),
    ...metaChips(unit.meta),
    anonymized ? el("span", { class: "chip chip--ghost quote__anon" }, "pseudonymized") : null,
    gold !== undefined && gold !== null
      ? el("span", { class: "chip chip--gold", title: "Gold-standard (human) label" }, `gold: ${gold}`)
      : null,
  );

  return el("figure", {
    class: `quote${compact ? " quote--compact" : ""}`,
    dataset: evidence && unit.id ? { evidence: unit.id } : {},
  }, body, source);
}

/**
 * Deterministic content-category → hue slot (0–5). Pure; shared by the
 * dossier's category chips so a category keeps its tint everywhere.
 */
export function catSlot(category) {
  const s = String(category ?? "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h % 6;
}

/* Build text nodes + <mark> spans from highlight offsets. Pure-ish; exported
   for probing. Returns an array of Nodes (in DOM) — or, given a factory,
   plain segment descriptors. */
export function renderSpans(text, highlights = []) {
  const segs = segment(text, highlights);
  return segs.map((s) =>
    s.mark
      ? el("mark", {
          class: `quote__hit${s.kind === "pii" ? " quote__hit--pii" : ""}`,
          dataset: {
            cat: s.category ?? "",
            kind: s.kind ?? "dict",
            slot: s.kind === "pii" ? null : String(catSlot(s.category)),
          },
          title: s.category ? `dictionary: ${s.category}` : undefined,
        }, s.text)
      : s.text,
  );
}

/** Pure: split text into [{text, mark, category?, kind?}] segments.
    Sorts, clamps to bounds, drops zero-length and overlapping remainders. */
export function segment(text, highlights = []) {
  const n = text.length;
  const spans = (highlights || [])
    .map((h) => ({
      start: Math.max(0, Math.min(n, h.start | 0)),
      end: Math.max(0, Math.min(n, h.end | 0)),
      category: h.category,
      kind: h.kind ?? "dict",
    }))
    .filter((h) => h.end > h.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const out = [];
  let cursor = 0;
  for (const h of spans) {
    if (h.start < cursor) continue; // overlap with an earlier span — keep first
    if (h.start > cursor) out.push({ text: text.slice(cursor, h.start), mark: false });
    out.push({ text: text.slice(h.start, h.end), mark: true, category: h.category, kind: h.kind });
    cursor = h.end;
  }
  if (cursor < n) out.push({ text: text.slice(cursor), mark: false });
  if (out.length === 0) out.push({ text, mark: false });
  return out;
}

const POS_LABELS = { doc: "doc", row: "row", para: "¶", turn: "turn", speaker: "" };

function posChips(pos) {
  if (!pos) return [];
  const chips = [];
  for (const key of ["doc", "row", "para", "turn", "speaker"]) {
    const v = pos[key];
    if (v === undefined || v === null || v === "") continue;
    const label = POS_LABELS[key];
    chips.push(el("span", { class: "quote__pos" }, label ? `${label} ${v}` : String(v)));
  }
  if (pos.t0 !== undefined && pos.t0 !== null) {
    chips.push(el("span", { class: "quote__pos" }, `${clock(pos.t0)}–${clock(pos.t1 ?? pos.t0)}`));
  }
  return chips;
}

function clock(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

const META_LIMIT = 5;

function metaChips(meta) {
  if (!meta) return [];
  const entries = Object.entries(meta).filter(([, v]) => v !== null && v !== undefined && v !== "");
  const shown = entries.slice(0, META_LIMIT);
  const rest = entries.length - shown.length;
  const chips = shown.map(([k, v]) => el("span", { class: "chip chip--meta" }, `${k}: ${v}`));
  if (rest > 0) {
    chips.push(el("span", {
      class: "chip chip--meta chip--more",
      title: entries.slice(META_LIMIT).map(([k, v]) => `${k}: ${v}`).join("\n"),
    }, `+${rest}`));
  }
  return chips;
}
