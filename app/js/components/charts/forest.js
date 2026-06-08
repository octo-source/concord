// Forest plot — a horizontal interval plot for reliability coefficients on a
// fixed [0,1] axis: one row per instrument with a point at its κ (or α) and a
// 95% CI whisker, the Landis–Koch / Krippendorff benchmark bands as a quiet
// backdrop, and an optional reference row (the human-agreement ceiling) drawn
// with its own gold marker and a dashed reference line across the plot. This
// is the freeze/model-choice decision surface on the Calibration Test pane.
//
// Reuses the chartkit shell (figure + accessible table twin + draw-in) and the
// scale arithmetic; geometry mirrors bar.js (labelWidth gutter, valueWidth
// tail, CI caps). Color is per ROW (gold = human, machine = ink-blue) because
// the human ceiling and the instruments live in one chart — bar.js carries a
// single ink, so this focused renderer earns its place. Color-blind safe: the
// benchmark bands read by POSITION (ticks at the thresholds) as much as hue,
// and every point sits at its value with a printed number + ladder mark.
//
//   render(container, data, opts) → { element, update, destroy }
//   toTable(data, opts)           → accessible <table> twin
//   layoutForest(data, opts)      → pure geometry (probeable under node)
//
// data: [{ label, value, ci?: [lo,hi], level?, kind?: "human"|"machine",
//          reference?: boolean, evidence?: unitId|unitId[], evidenceTotal? }]
//   reference: true → a ceiling row (gold marker + dashed vertical guide)
//   kind:      color family; defaults to "machine" ("human" → gold)

import { svgEl } from "../../dom.js";
import { linearScale } from "./scale.js";
import { chartFigure, observeWidth, svgRoot, dataTable, fitLabel } from "./chartkit.js";
import { mark } from "../ladder.js";
import { fmt } from "../../format.js";

// Landis–Koch κ bands (the Test pane's headline convention): below .61 is the
// "moderate-or-worse" floor, .61–.81 substantial, .81–1 almost perfect.
// Krippendorff's working α bands (.667 / .800) ride the same shape for ordinal
// surfaces that headline α.
const BANDS = {
  "κ": { thresholds: [0.61, 0.81], ticks: [".61", ".81"] },
  "α": { thresholds: [0.667, 0.8], ticks: [".67", ".80"] },
};

/* ---- pure geometry --------------------------------------------------------
 * layoutForest(data, { width, domain, labelWidth, valueWidth, rowHeight,
 *                      padTop, padBottom, stat })
 * → { width, height, x0, x1, domain, ticks, bands, rows: [{ label, y,
 *     centerY, x, value, ci?: {x1,x2}, reference, kind, level }] }
 * ------------------------------------------------------------------------ */
export function layoutForest(data, {
  width = 600,
  domain = [0, 1],
  labelWidth = 150,
  valueWidth = 84,
  rowHeight = 26,
  padTop = 10,
  padBottom = 22,
  stat = "κ",
} = {}) {
  const x0 = labelWidth + 10;
  const x1 = Math.max(x0 + 60, width - valueWidth);
  const [lo, hi] = domain;
  const scale = linearScale([lo, hi], [x0, x1]);

  const band = BANDS[stat] ?? BANDS["κ"];
  const bands = {
    thresholds: band.thresholds.map((t) => ({ value: t, x: scale(t) })),
    // three zones: [lo, t0) low · [t0, t1) mid · [t1, hi] high
    zones: [
      { kind: "low", x: scale(lo), w: scale(band.thresholds[0]) - scale(lo) },
      { kind: "mid", x: scale(band.thresholds[0]), w: scale(band.thresholds[1]) - scale(band.thresholds[0]) },
      { kind: "high", x: scale(band.thresholds[1]), w: scale(hi) - scale(band.thresholds[1]) },
    ],
    tickLabels: band.ticks,
  };

  const rows = data.map((d, i) => {
    const y = padTop + i * rowHeight;
    const v = Number(d.value);
    const row = {
      label: d.label,
      y,
      centerY: y + rowHeight / 2,
      value: Number.isFinite(v) ? v : null,
      x: Number.isFinite(v) ? scale(v) : null,
      reference: Boolean(d.reference),
      kind: d.kind ?? (d.reference ? "human" : "machine"),
      level: d.level ?? null,
      ci: null,
    };
    if (Array.isArray(d.ci) && d.ci.length === 2 && Number.isFinite(Number(d.ci[0])) && Number.isFinite(Number(d.ci[1]))) {
      row.ci = { x1: scale(Number(d.ci[0])), x2: scale(Number(d.ci[1])), lo: Number(d.ci[0]), hi: Number(d.ci[1]) };
    }
    return row;
  });

  return {
    width,
    height: padTop + rows.length * rowHeight + padBottom,
    x0, x1,
    domain: [lo, hi],
    ticks: scale.ticks(5).map((t) => ({ value: t, x: scale(t) })),
    bands,
    rows,
  };
}

/** Accessible twin: label · stat · 95% CI per row. */
export function toTable(data, { stat = "κ", caption = "Reliability forest plot", format = (v) => fmt(v, 2) } = {}) {
  return dataTable(caption,
    ["", stat, "95% CI"],
    data.map((d) => [
      d.reference ? `${d.label} (reference)` : d.label,
      format(d.value),
      Array.isArray(d.ci) && d.ci.length === 2 ? `[${format(d.ci[0])}, ${format(d.ci[1])}]` : "—",
    ]));
}

/** Mount the forest. */
export function render(container, data, opts = {}) {
  const {
    caption = null,
    stat = "κ",
    format = (v) => fmt(v, 2),
  } = opts;

  const { figure, mount } = chartFigure({
    caption,
    table: toTable(data, { stat, caption: caption ?? "Reliability forest plot", format }),
    chartClass: "chart--forest chart--ink-machine",
  });
  container.append(figure);

  let current = data;
  const destroyResize = observeWidth(mount, (width, first) => {
    mount.replaceChildren(draw(current, width, first));
  });

  function draw(d, width, first) {
    const g = layoutForest(d, { ...opts, width, stat });
    const svg = svgRoot(g.width, g.height, caption ?? "Reliability forest plot");
    if (first) svg.classList.add("chart--draw");

    // --- benchmark bands (backdrop) + threshold ticks -----------------------
    const bandG = svgEl("g", { class: "forest__bands" });
    const plotBottom = g.height - 16; // leave the bottom strip for axis ticks
    for (const z of g.bands.zones) {
      if (z.w <= 0) continue;
      bandG.append(svgEl("rect", {
        x: z.x, y: 0, width: z.w, height: plotBottom,
        class: `forest__band forest__band--${z.kind}`,
      }));
    }
    for (const t of g.bands.thresholds) {
      bandG.append(svgEl("line", {
        x1: t.x, y1: 2, x2: t.x, y2: g.height - 16, class: "forest__threshold",
      }));
    }
    svg.append(bandG);

    // --- axis: baseline at domain start + ticks -----------------------------
    const axis = svgEl("g", { class: "chart__axis" });
    axis.append(svgEl("line", { x1: g.x0, y1: 2, x2: g.x0, y2: g.height - 16, class: "chart__baseline" }));
    for (const t of g.ticks) {
      axis.append(svgEl("text", {
        x: t.x, y: g.height - 4, class: "chart__tick", "text-anchor": "middle",
      }, format(t.value)));
    }
    // threshold tick labels (the .61/.81 benchmarks, just under the top edge —
    // position is the color-blind-safe reading of the bands)
    g.bands.thresholds.forEach((t, i) => {
      axis.append(svgEl("text", {
        x: t.x, y: 9, class: "forest__thresholdtick", "text-anchor": "middle",
      }, g.bands.tickLabels[i]));
    });
    svg.append(axis);

    // --- reference guide lines (dashed verticals at each reference value) ----
    for (const row of g.rows) {
      if (row.reference && row.x !== null) {
        svg.append(svgEl("line", {
          x1: row.x, y1: 8, x2: row.x, y2: g.height - 16,
          class: "forest__refline",
        }));
      }
    }

    // --- rows ---------------------------------------------------------------
    g.rows.forEach((row, i) => {
      const datum = d[i];
      const rowG = svgEl("g", {
        class: `chart__row forest__row forest__row--${row.kind}${row.reference ? " forest__row--reference" : ""}`,
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
              class: `chart__row forest__row forest__row--${row.kind} evidence-door`,
            }
          : {}),
      });

      rowG.append(svgEl("text", {
        x: g.x0 - 10, y: row.centerY, class: "chart__rowlabel forest__rowlabel",
        "text-anchor": "end", "dominant-baseline": "middle",
      }, fitLabel(row.label, g.x0 - 16)));

      // CI whisker (line + end caps)
      if (row.ci) {
        rowG.append(
          svgEl("line", { x1: row.ci.x1, y1: row.centerY, x2: row.ci.x2, y2: row.centerY, class: "forest__ci" }),
          svgEl("line", { x1: row.ci.x1, y1: row.centerY - 4, x2: row.ci.x1, y2: row.centerY + 4, class: "forest__ci" }),
          svgEl("line", { x1: row.ci.x2, y1: row.centerY - 4, x2: row.ci.x2, y2: row.centerY + 4, class: "forest__ci" }),
        );
      }

      // the point — a diamond for the reference ceiling, a disc for instruments
      if (row.x !== null) {
        if (row.reference) {
          const r = 5;
          rowG.append(svgEl("path", {
            d: `M ${row.x} ${row.centerY - r} L ${row.x + r} ${row.centerY} L ${row.x} ${row.centerY + r} L ${row.x - r} ${row.centerY} Z`,
            class: "forest__point forest__point--reference",
          }));
        } else {
          rowG.append(svgEl("circle", {
            cx: row.x, cy: row.centerY, r: 4.5, class: "forest__point",
          }));
        }
      }

      // value + ladder mark in the tail
      const markGlyph = row.level ? ` ${mark(row.level)}` : "";
      rowG.append(svgEl("text", {
        x: g.x1 + 8, y: row.centerY, class: "chart__value forest__value",
        "dominant-baseline": "middle",
      }, row.value === null ? "—" : `${format(row.value)}${markGlyph}`));

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
      twin?.replaceWith(toTable(current, { stat, caption: caption ?? "Reliability forest plot", format }));
    },
    destroy() {
      destroyResize();
      figure.remove();
    },
  };
}
