// Confusion matrix as a clickable heat-table. Counts tint in the machine
// blue (sequential — deeper means more), the agreement diagonal is set off
// with an inset hairline ring, and every cell is a door: cells carry
// data-evidence with the unit ids that landed there.

import { el } from "../dom.js";

/**
 * render({ labels, matrix, rowAxis, colAxis, evidence, caption }) → <figure>
 *   labels   ["pay", "management", …] — shared by both axes
 *   matrix   number[][] — matrix[r][c] = count (rows = rowAxis truth)
 *   rowAxis  axis name for rows (default "Gold")    — the human side
 *   colAxis  axis name for columns (default "Machine")
 *   evidence optional unitId[][][] or {"r,c": unitId[]} per cell
 *   onCell   (r, c, count) — called on click in addition to evidence opening
 */
export function render({
  labels = [],
  matrix = [],
  rowAxis = "Gold",
  colAxis = "Machine",
  evidence = null,
  caption = "Confusion matrix",
  onCell = null,
} = {}) {
  const max = Math.max(1, ...matrix.flat().map((v) => Number(v) || 0));
  const total = matrix.flat().reduce((s, v) => s + (Number(v) || 0), 0);

  const table = el("table", { class: "confusion" },
    el("caption", { class: "sr-only" },
      `${caption}: ${rowAxis} rows by ${colAxis} columns, ${total} units.`),
    el("thead", {},
      el("tr", {},
        el("td", { class: "confusion__corner" },
          el("span", { class: "confusion__axis confusion__axis--row" }, rowAxis + " ↓"),
          el("span", { class: "confusion__axis confusion__axis--col" }, colAxis + " →"),
        ),
        ...labels.map((l) => el("th", { scope: "col", class: "confusion__collabel data" }, l)),
      )),
    el("tbody", {},
      ...matrix.map((row, r) =>
        el("tr", {},
          el("th", { scope: "row", class: "confusion__rowlabel data" }, labels[r] ?? `r${r}`),
          ...row.map((count, c) => cell(r, c, count)),
        ))),
  );

  function cell(r, c, rawCount) {
    const count = Number(rawCount) || 0;
    const t = count / max;                       // 0..1 sequential
    const pct = Math.round(t * 62);              // cap the tint so ink stays legible
    const diagonal = r === c;
    const ids = cellEvidence(evidence, r, c);
    const deep = t > 0.62;

    const btn = el("button", {
      class: `confusion__cell${diagonal ? " confusion__cell--diag" : ""}${deep ? " confusion__cell--deep" : ""}`,
      type: "button",
      style: { "--tint": `${pct}%` },
      dataset: ids.length ? { evidence: ids.join(",") } : {},
      aria: {
        label: `${labels[r] ?? r} read as ${labels[c] ?? c}: ${count} unit${count === 1 ? "" : "s"}${diagonal ? " (agreement)" : ""}`,
      },
      onclick: () => onCell?.(r, c, count),
    },
      el("span", { class: "confusion__count data" }, String(count)),
    );
    return el("td", { class: "confusion__td" }, btn);
  }

  return el("figure", { class: "confusion-wrap" },
    table,
    el("figcaption", { class: "confusion__caption" },
      el("span", { class: "overline" }, caption),
      el("span", { class: "confusion__legend data" },
        `n = ${total} · diagonal = agreement · every cell opens its units`),
    ),
  );
}

/** Pure: evidence lookup tolerant of array-of-arrays or {"r,c": ids}. */
export function cellEvidence(evidence, r, c) {
  if (!evidence) return [];
  if (Array.isArray(evidence)) return evidence[r]?.[c] ?? [];
  return evidence[`${r},${c}`] ?? [];
}
