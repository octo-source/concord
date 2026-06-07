// Horizontal bars, Tufte-spare: direct value labels (no legend, no grid
// heavier than the data), tabular mono numerals, every value wearing its
// ladder mark. Two fills only: SOLID = corrected/actual, HATCHED = naive/
// uncorrected. Paired mode draws both per row with a Δ annotation — this is
// the Correction Reveal primitive the workbench composes.
//
//   render(container, data, opts) → { element, update, destroy }
//   toTable(data, opts)           → accessible <table> twin
//   layoutBars(data, opts)        → pure geometry (probeable under node)
//
// data (simple):  [{ label, value, ci?: [lo,hi], level?, variant?: "solid"|
//                    "hatch", evidence?: unitId|unitId[], evidenceTotal? }]
// data (paired):  [{ label, corrected: {value, ci?}, naive: {value},
//                    level?, evidence?, evidenceTotal? }] with opts.paired = true
// evidenceTotal: the TRUE unit count behind the door — evidence id lists cap
// at 100 server-side, and the inspector says "first 100 of N" when capped.

import { svgEl } from "../../dom.js";
import { linearScale, niceDomain, extent } from "./scale.js";
import { chartFigure, hatchPattern, observeWidth, svgRoot, dataTable, fitLabel } from "./chartkit.js";
import { mark } from "../ladder.js";
import { fmt } from "../../format.js";

/* ---- pure geometry --------------------------------------------------------
 * layoutBars(data, { width, paired, domain, labelWidth, valueWidth,
 *                    rowHeight, barSize, pairGap, padTop })
 * → { width, height, x0, x1, domain, ticks,
 *     rows: [{ label, y, centerY,
 *              bars: [{ kind, x, y, w, h, value, variant, ci? }],
 *              labels: [{ x, y, text, kind }], delta? }] }
 * ------------------------------------------------------------------------ */
export function layoutBars(data, {
  width = 600,
  paired = false,
  domain = null,
  labelWidth = 132,
  valueWidth = 76,
  rowHeight = null,
  barSize = 14,
  pairGap = 4,
  padTop = 6,
  padBottom = 18,
} = {}) {
  const rh = rowHeight ?? (paired ? barSize * 2 + pairGap + 14 : barSize + 14);
  const x0 = labelWidth + 10;
  const x1 = Math.max(x0 + 60, width - valueWidth);

  const values = paired
    ? data.flatMap((d) => [
        d.corrected?.value, d.naive?.value,
        ...(d.corrected?.ci ?? []),
      ])
    : data.flatMap((d) => [d.value, ...(d.ci ?? [])]);
  const [lo, hi] = domain ?? niceDomain(extent([0, ...values]), 4);
  const scale = linearScale([lo, hi], [x0, x1]);
  const zero = scale(Math.max(lo, 0));

  const rows = data.map((d, i) => {
    const y = padTop + i * rh;
    const row = { label: d.label, y, centerY: y + rh / 2, bars: [], labels: [], delta: null };

    const makeBar = (kind, value, variant, offsetY, ci) => {
      const v = Number(value) || 0;
      const bx = Math.min(zero, scale(v));
      const bw = Math.abs(scale(v) - zero);
      const bar = { kind, x: bx, y: y + offsetY, w: bw, h: barSize, value: v, variant };
      if (ci && ci.length === 2) {
        bar.ci = { x1: scale(ci[0]), x2: scale(ci[1]), y: y + offsetY + barSize / 2 };
      }
      row.bars.push(bar);
      row.labels.push({
        x: Math.max(zero, scale(v)) + 6,
        y: y + offsetY + barSize / 2,
        text: null, // text composed by the renderer/formatter
        kind,
        value: v,
      });
      return bar;
    };

    if (paired) {
      makeBar("corrected", d.corrected?.value, "solid", 2, d.corrected?.ci);
      makeBar("naive", d.naive?.value, "hatch", 2 + barSize + pairGap, d.naive?.ci);
      const delta = (Number(d.corrected?.value) || 0) - (Number(d.naive?.value) || 0);
      row.delta = { value: delta, x: x1 + valueWidth - 6, y: y + 2 + barSize + pairGap / 2 };
    } else {
      makeBar("value", d.value, d.variant === "hatch" ? "hatch" : "solid", (rh - barSize) / 2 - 2, d.ci);
    }
    return row;
  });

  return {
    width,
    height: padTop + rows.length * rh + padBottom,
    x0, x1,
    domain: [lo, hi],
    zero,
    ticks: scale.ticks(4).map((t) => ({ value: t, x: scale(t) })),
    rows,
  };
}

/** Accessible twin. */
export function toTable(data, { paired = false, caption = "Bar chart data", format = (v) => fmt(v, 2) } = {}) {
  if (paired) {
    return dataTable(caption,
      ["", "Corrected ◉", "Naive (uncorrected)", "Δ"],
      data.map((d) => [
        d.label,
        format(d.corrected?.value),
        format(d.naive?.value),
        format((Number(d.corrected?.value) || 0) - (Number(d.naive?.value) || 0)),
      ]));
  }
  return dataTable(caption, ["", "Value"], data.map((d) => [d.label, format(d.value)]));
}

/** Mount the chart. */
export function render(container, data, opts = {}) {
  const {
    caption = null,
    paired = false,
    format = (v) => fmt(v, 2),
    level = null,
    color = "machine", // semantic family carried by currentColor
  } = opts;

  const { figure, mount } = chartFigure({
    caption,
    table: toTable(data, { paired, caption: caption ?? "Bar chart data", format }),
    chartClass: `chart--bar chart--ink-${color}`,
  });
  container.append(figure);

  let current = data;

  const destroyResize = observeWidth(mount, (width, first) => {
    mount.replaceChildren(draw(current, width, first));
  });

  function draw(d, width, first) {
    const g = layoutBars(d, { ...opts, width, paired });
    const svg = svgRoot(g.width, g.height, caption ?? "Bar chart");
    if (first) svg.classList.add("chart--draw");
    const hatch = hatchPattern(svg);

    // baseline + ticks — hairline, lighter than data
    const axis = svgEl("g", { class: "chart__axis" });
    axis.append(svgEl("line", { x1: g.zero, y1: 0, x2: g.zero, y2: g.height - 14, class: "chart__baseline" }));
    for (const t of g.ticks) {
      axis.append(svgEl("text", {
        x: t.x, y: g.height - 4, class: "chart__tick", "text-anchor": "middle",
      }, format(t.value)));
    }
    svg.append(axis);

    g.rows.forEach((row, i) => {
      const datum = d[i];
      const rowG = svgEl("g", {
        class: "chart__row",
        style: `--i:${i}`,
        ...(datum.evidence
          ? {
              "data-evidence": Array.isArray(datum.evidence) ? datum.evidence.join(",") : datum.evidence,
              ...(datum.evidenceTotal !== undefined && datum.evidenceTotal !== null
                ? { "data-evidence-total": String(datum.evidenceTotal) }
                : {}),
              tabindex: "0",
              role: "button",
              "aria-label": `${row.label}: open evidence`,
              class: "chart__row evidence-door",
            }
          : {}),
      });

      rowG.append(svgEl("text", {
        x: g.x0 - 10, y: row.centerY, class: "chart__rowlabel",
        "text-anchor": "end", "dominant-baseline": "middle",
      }, fitLabel(row.label, g.x0 - 18)));

      for (const bar of row.bars) {
        const isHatch = bar.variant === "hatch";
        rowG.append(svgEl("rect", {
          x: bar.x, y: bar.y, width: Math.max(0.5, bar.w), height: bar.h,
          class: `chart__bar chart__bar--${isHatch ? "hatch" : "solid"}`,
          fill: isHatch ? hatch : "currentColor",
          ...(isHatch ? { stroke: "currentColor", "stroke-width": 1 } : {}),
        }));
        if (bar.ci) {
          rowG.append(
            svgEl("line", { x1: bar.ci.x1, y1: bar.ci.y, x2: bar.ci.x2, y2: bar.ci.y, class: "chart__ci" }),
            svgEl("line", { x1: bar.ci.x1, y1: bar.ci.y - 3.5, x2: bar.ci.x1, y2: bar.ci.y + 3.5, class: "chart__ci" }),
            svgEl("line", { x1: bar.ci.x2, y1: bar.ci.y - 3.5, x2: bar.ci.x2, y2: bar.ci.y + 3.5, class: "chart__ci" }),
          );
        }
      }

      for (const lbl of row.labels) {
        const lv = lbl.kind === "corrected" ? "corrected" : (datum.level ?? level);
        const markGlyph = lbl.kind === "naive" ? null : lv ? ` ${mark(lv)}` : "";
        rowG.append(svgEl("text", {
          x: lbl.x, y: lbl.y, class: `chart__value${lbl.kind === "naive" ? " chart__value--naive" : ""}`,
          "dominant-baseline": "middle",
        }, `${format(lbl.value)}${markGlyph ?? ""}${lbl.kind === "naive" ? " naive" : ""}`));
      }

      if (row.delta) {
        rowG.append(svgEl("text", {
          x: row.delta.x, y: row.delta.y, class: "chart__delta",
          "text-anchor": "end", "dominant-baseline": "middle",
        }, `Δ ${row.delta.value >= 0 ? "+" : "−"}${format(Math.abs(row.delta.value))}`));
      }

      svg.append(rowG);
    });

    return svg;
  }

  return {
    element: figure,
    update(nextData) {
      current = nextData;
      mount.replaceChildren(draw(current, mount.clientWidth || 600, false));
      const twin = figure.querySelector(".chart__data table");
      twin?.replaceWith(toTable(current, { paired, caption: caption ?? "Bar chart data", format }));
    },
    destroy() {
      destroyResize();
      figure.remove();
    },
  };
}
