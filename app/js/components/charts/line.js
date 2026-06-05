// Time-trend lines with direct end-labels (no legend). Hairline axes, mono
// tick numerals, optional point dots. The first composition draws the
// strokes in over 150ms; recompositions are instant.
//
//   render(container, series, opts) → { element, update, destroy }
//   layoutLines(series, opts)       → pure geometry
//   toTable(series, opts)           → accessible twin
//
// series: [{ label, points: [{x, y}], emphasis? }] — x is a number
// (epoch ms or ordinal); opts.formatX/formatY control tick text.

import { svgEl } from "../../dom.js";
import { linearScale, niceDomain, extent } from "./scale.js";
import { chartFigure, observeWidth, svgRoot, dataTable, fitLabel } from "./chartkit.js";
import { fmt } from "../../format.js";

/* ---- pure geometry ------------------------------------------------------- */
export function layoutLines(series, {
  width = 600,
  height = 220,
  padLeft = 44,
  padRight = 110, // room for direct end-labels
  padTop = 12,
  padBottom = 24,
  xDomain = null,
  yDomain = null,
} = {}) {
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  const dx = xDomain ?? extent(xs);
  const dy = yDomain ?? niceDomain(extent(ys), 3);
  const sx = linearScale(dx, [padLeft, width - padRight]);
  const sy = linearScale(dy, [height - padBottom, padTop]);

  const lines = series.map((s) => {
    const pts = s.points
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .sort((a, b) => a.x - b.x)
      .map((p) => ({ x: sx(p.x), y: sy(p.y), vx: p.x, vy: p.y }));
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${round2(p.x)},${round2(p.y)}`).join("");
    const last = pts[pts.length - 1] ?? null;
    return {
      label: s.label,
      emphasis: Boolean(s.emphasis),
      d,
      points: pts,
      endLabel: last ? { x: last.x + 8, y: last.y, text: s.label, value: last.vy } : null,
    };
  });

  // de-collide end labels vertically (14px minimum separation)
  const labels = lines.map((l) => l.endLabel).filter(Boolean).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  }

  return {
    width, height,
    x: sx, y: sy,
    xTicks: sx.ticks(4).map((t) => ({ value: t, x: sx(t) })),
    yTicks: sy.ticks(3).map((t) => ({ value: t, y: sy(t) })),
    baselineY: height - padBottom,
    lines,
  };
}

export function toTable(series, { caption = "Trend data", formatX = (x) => String(x), formatY = (v) => fmt(v, 2) } = {}) {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  return dataTable(caption,
    ["", ...series.map((s) => s.label)],
    xs.map((x) => [
      formatX(x),
      ...series.map((s) => {
        const p = s.points.find((q) => q.x === x);
        return p ? formatY(p.y) : "—";
      }),
    ]));
}

export function render(container, series, opts = {}) {
  const {
    caption = null,
    height = 220,
    formatX = (x) => String(x),
    formatY = (v) => fmt(v, 2),
    dots = false,
  } = opts;

  const { figure, mount } = chartFigure({
    caption,
    table: toTable(series, { caption: caption ?? "Trend data", formatX, formatY }),
    chartClass: "chart--line",
  });
  container.append(figure);

  let current = series;

  const destroyResize = observeWidth(mount, (width, first) => {
    mount.replaceChildren(draw(current, width, first));
  });

  function draw(s, width, first) {
    const g = layoutLines(s, { ...opts, width, height });
    const svg = svgRoot(g.width, g.height, caption ?? "Trend chart");
    if (first) svg.classList.add("chart--draw");

    const axis = svgEl("g", { class: "chart__axis" });
    axis.append(svgEl("line", {
      x1: g.x.range[0], y1: g.baselineY, x2: g.x.range[1], y2: g.baselineY, class: "chart__baseline",
    }));
    for (const t of g.xTicks) {
      axis.append(svgEl("text", { x: t.x, y: g.baselineY + 14, class: "chart__tick", "text-anchor": "middle" }, formatX(t.value)));
    }
    for (const t of g.yTicks) {
      axis.append(
        svgEl("text", { x: g.x.range[0] - 8, y: t.y, class: "chart__tick", "text-anchor": "end", "dominant-baseline": "middle" }, formatY(t.value)),
        svgEl("line", { x1: g.x.range[0] - 4, y1: t.y, x2: g.x.range[0], y2: t.y, class: "chart__baseline" }),
      );
    }
    svg.append(axis);

    g.lines.forEach((line, i) => {
      const lineG = svgEl("g", { class: `chart__series${line.emphasis ? " chart__series--emphasis" : ""}`, style: `--i:${i}` });
      lineG.append(svgEl("path", { d: line.d, class: "chart__line", fill: "none" }));
      if (dots) {
        for (const p of line.points) {
          lineG.append(svgEl("circle", { cx: p.x, cy: p.y, r: 2.4, class: "chart__dot" }));
        }
      }
      if (line.endLabel) {
        lineG.append(svgEl("text", {
          x: line.endLabel.x, y: line.endLabel.y, class: "chart__endlabel",
          "dominant-baseline": "middle",
        }, fitLabel(line.endLabel.text, 100), " ",
          svgEl("tspan", { class: "chart__endvalue" }, formatY(line.endLabel.value))));
      }
      svg.append(lineG);
    });

    return svg;
  }

  return {
    element: figure,
    update(next) {
      current = next;
      mount.replaceChildren(draw(current, mount.clientWidth || 600, false));
      figure.querySelector(".chart__data table")
        ?.replaceWith(toTable(current, { caption: caption ?? "Trend data", formatX, formatY }));
    },
    destroy() {
      destroyResize();
      figure.remove();
    },
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
