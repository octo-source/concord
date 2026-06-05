// Heat grid (SVG) — co-occurrence matrices and any labels×labels intensity
// surface. Sequential tint of the machine blue via opacity on currentColor;
// values print directly in cells once they have room. Cells with evidence
// ids are doors. (The confusion matrix component is its HTML-table sibling;
// this one composes into chart grids and small multiples.)
//
//   render(container, data, opts) → { element, update, destroy }
//   layoutHeat(data, opts)        → pure geometry
//
// data: { rows: ["pay", …], cols: ["pay", …], values: number[][],
//         evidence?: unitId[][][] }

import { svgEl } from "../../dom.js";
import { chartFigure, observeWidth, svgRoot, dataTable, fitLabel } from "./chartkit.js";
import { fmt } from "../../format.js";

/* ---- pure geometry ------------------------------------------------------- */
export function layoutHeat({ rows = [], cols = [], values = [] }, {
  width = 420,
  labelWidth = 96,
  colLabelHeight = 64,
  cellGap = 2,
  maxCell = 56,
} = {}) {
  const n = cols.length || 1;
  const cell = Math.max(14, Math.min(maxCell, (width - labelWidth - cellGap * (n - 1)) / n));
  const max = Math.max(1, ...values.flat().map((v) => Number(v) || 0));

  const cells = [];
  values.forEach((row, r) => {
    row.forEach((v, c) => {
      const value = Number(v) || 0;
      cells.push({
        r, c, value,
        t: value / max,
        x: labelWidth + c * (cell + cellGap),
        y: colLabelHeight + r * (cell + cellGap),
        size: cell,
      });
    });
  });

  return {
    width: labelWidth + cols.length * (cell + cellGap) - cellGap,
    height: colLabelHeight + rows.length * (cell + cellGap) - cellGap,
    cell, max, cells,
    rowLabels: rows.map((label, r) => ({ label, x: labelWidth - 8, y: colLabelHeight + r * (cell + cellGap) + cell / 2 })),
    colLabels: cols.map((label, c) => ({ label, x: labelWidth + c * (cell + cellGap) + cell / 2, y: colLabelHeight - 8 })),
  };
}

export function toTable({ rows = [], cols = [], values = [] }, { caption = "Heat map data", format = (v) => fmt(v, 0) } = {}) {
  return dataTable(caption,
    ["", ...cols],
    rows.map((r, i) => [r, ...(values[i] ?? []).map((v) => format(v))]));
}

export function render(container, data, opts = {}) {
  const {
    caption = null,
    format = (v) => fmt(v, 0),
    showValues = true,
  } = opts;

  const { figure, mount } = chartFigure({
    caption,
    table: toTable(data, { caption: caption ?? "Heat map data", format }),
    chartClass: "chart--heat chart--ink-machine",
  });
  container.append(figure);

  let current = data;

  const destroyResize = observeWidth(mount, (width, first) => {
    mount.replaceChildren(draw(current, Math.min(width, 640), first));
  });

  function draw(d, width, first) {
    const g = layoutHeat(d, { ...opts, width });
    const svg = svgRoot(g.width, g.height, caption ?? "Heat map");
    if (first) svg.classList.add("chart--draw");

    for (const l of g.rowLabels) {
      svg.append(svgEl("text", { x: l.x, y: l.y, class: "chart__rowlabel", "text-anchor": "end", "dominant-baseline": "middle" }, fitLabel(l.label, 88)));
    }
    for (const l of g.colLabels) {
      svg.append(svgEl("text", {
        x: l.x, y: l.y, class: "chart__rowlabel",
        "text-anchor": "start", transform: `rotate(-42 ${l.x} ${l.y})`,
      }, fitLabel(l.label, 80)));
    }

    for (const cell of g.cells) {
      const ids = d.evidence?.[cell.r]?.[cell.c] ?? [];
      const cellG = svgEl("g", {
        class: "chart__heatcell",
        style: `--i:${cell.r * (d.cols?.length || 1) + cell.c}`,
        ...(ids.length
          ? { "data-evidence": ids.join(","), tabindex: "0", role: "button",
              "aria-label": `${d.rows[cell.r]} × ${d.cols[cell.c]}: ${format(cell.value)} — open evidence` }
          : {}),
      });
      cellG.append(svgEl("rect", {
        x: cell.x, y: cell.y, width: cell.size, height: cell.size,
        class: "chart__heatrect",
        fill: "currentColor",
        "fill-opacity": (0.06 + cell.t * 0.78).toFixed(3),
        rx: 1,
      }));
      if (showValues && cell.size >= 26 && cell.value !== 0) {
        cellG.append(svgEl("text", {
          x: cell.x + cell.size / 2, y: cell.y + cell.size / 2,
          class: `chart__heatvalue${cell.t > 0.55 ? " chart__heatvalue--deep" : ""}`,
          "text-anchor": "middle", "dominant-baseline": "central",
        }, format(cell.value)));
      }
      svg.append(cellG);
    }

    return svg;
  }

  return {
    element: figure,
    update(next) {
      current = next;
      mount.replaceChildren(draw(current, Math.min(mount.clientWidth || 420, 640), false));
      figure.querySelector(".chart__data table")
        ?.replaceWith(toTable(current, { caption: caption ?? "Heat map data", format }));
    },
    destroy() {
      destroyResize();
      figure.remove();
    },
  };
}
