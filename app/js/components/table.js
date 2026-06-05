// Data table — hairline rules, mono numerals, sticky header, sortable
// columns, and cell-level evidence pass-through: any cell given an evidence
// key becomes a door into the inspector (data-evidence + delegated handler).

import { el, clear } from "../dom.js";
import * as ladder from "./ladder.js";

/**
 * render({ columns, rows, caption, sort, empty, dense }) → <div class="tablewrap">
 *   columns [{ key, label, numeric?, align?, sortable?=true, width?,
 *              format?(value, row) → string|Node,
 *              level?(row) → ladder level for the value's mark,
 *              evidence?(row) → unitId | unitId[] (cell opens the inspector) }]
 *   rows    array of records
 *   caption accessible table caption (visually hidden unless showCaption)
 *   sort    initial { key, dir: "asc"|"desc" }
 *   empty   { title, hint } for the designed empty state
 *
 * Element exposes .update({rows}) and .sortBy(key, dir).
 */
export function render({
  columns = [],
  rows = [],
  caption = "Data table",
  showCaption = false,
  sort = null,
  empty = {},
  dense = false,
} = {}) {
  let state = { rows: [...rows], sort: sort ? { ...sort } : null };

  const wrap = el("div", { class: `tablewrap${dense ? " tablewrap--dense" : ""}` });
  const table = el("table", { class: "table" });
  const cap = el("caption", { class: showCaption ? "table__caption" : "sr-only" }, caption);
  const thead = el("thead", {});
  const tbody = el("tbody", {});
  table.append(cap, thead, tbody);

  const headRow = el("tr", {});
  for (const col of columns) {
    const sortable = col.sortable !== false;
    const th = el("th", {
      scope: "col",
      class: cellClass(col),
      style: col.width ? { width: col.width } : undefined,
      aria: { sort: ariaSort(state.sort, col) },
    },
      sortable
        ? el("button", {
            class: "table__sortbtn",
            type: "button",
            onclick: () => {
              const dir = state.sort?.key === col.key && state.sort.dir === "asc" ? "desc" : "asc";
              sortBy(col.key, dir);
            },
          },
            el("span", {}, col.label),
            el("span", { class: "table__sortmark", aria: { hidden: "true" } }))
        : el("span", { class: "table__head-label" }, col.label),
    );
    headRow.append(th);
  }
  thead.append(headRow);

  function renderBody() {
    clear(tbody);
    if (state.rows.length === 0) {
      tbody.append(
        el("tr", { class: "table__empty-row" },
          el("td", { colspan: String(columns.length || 1) },
            el("div", { class: "empty-state empty-state--table" },
              el("p", { class: "empty-state__title" }, empty.title ?? "Nothing to show yet."),
              empty.hint ? el("p", { class: "empty-state__hint" }, empty.hint) : null,
            ))),
      );
      return;
    }
    for (const row of state.rows) {
      const tr = el("tr", {});
      for (const col of columns) {
        const raw = row[col.key];
        const formatted = col.format ? col.format(raw, row) : raw ?? "—";
        const level = col.level ? col.level(row) : null;
        const evidenceIds = col.evidence ? col.evidence(row) : null;
        const content = [
          formatted instanceof Node ? formatted : el("span", {}, String(formatted)),
          level ? ladder.render({ level, size: "sm" }) : null,
        ];
        const td = el("td", { class: cellClass(col) });
        if (evidenceIds && (Array.isArray(evidenceIds) ? evidenceIds.length : true)) {
          td.append(el("button", {
            class: "table__evidence evidence-door",
            type: "button",
            dataset: { evidence: Array.isArray(evidenceIds) ? evidenceIds.join(",") : evidenceIds },
            aria: { label: `Open evidence for ${col.label}` },
          }, ...content));
        } else {
          td.append(...content.filter(Boolean));
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
  }

  function sortBy(key, dir = "asc") {
    const col = columns.find((c) => c.key === key);
    if (!col) return;
    state.sort = { key, dir };
    state.rows = sortRows(state.rows, col, dir);
    for (const th of thead.querySelectorAll("th")) th.setAttribute("aria-sort", "none");
    const idx = columns.indexOf(col);
    headRow.children[idx]?.setAttribute("aria-sort", dir === "asc" ? "ascending" : "descending");
    renderBody();
  }

  if (state.sort) {
    const col = columns.find((c) => c.key === state.sort.key);
    if (col) state.rows = sortRows(state.rows, col, state.sort.dir);
  }
  renderBody();

  wrap.append(table);
  wrap.update = ({ rows: nextRows }) => {
    state.rows = [...(nextRows ?? [])];
    if (state.sort) sortBy(state.sort.key, state.sort.dir);
    else renderBody();
  };
  wrap.sortBy = sortBy;
  return wrap;
}

/** Pure sort: numeric-aware, stable, nulls sink in BOTH directions
    (a missing κ must never head the descending leaderboard). Exported for
    probing. */
export function sortRows(rows, col, dir = "asc") {
  const sign = dir === "desc" ? -1 : 1;
  const isNull = (v) => v === null || v === undefined || v === "";
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const va = a.row[col.key];
      const vb = b.row[col.key];
      const aNull = isNull(va);
      const bNull = isNull(vb);
      if (aNull || bNull) {
        if (aNull && bNull) return a.i - b.i;
        return aNull ? 1 : -1; // outside the sign — nulls last either way
      }
      const cmp = compareValues(va, vb, col.numeric);
      return cmp !== 0 ? cmp * sign : a.i - b.i;
    })
    .map(({ row }) => row);
}

function compareValues(a, b, numeric) {
  if (numeric || (typeof a === "number" && typeof b === "number")) {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function cellClass(col) {
  const classes = [];
  if (col.numeric) classes.push("table__num", "data");
  if (col.align) classes.push(`table__align-${col.align}`);
  return classes.join(" ") || undefined;
}

function ariaSort(sort, col) {
  if (!sort || sort.key !== col.key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}
