// Triangulation scatter — instrument vs instrument. The identity diagonal
// is the quiet reference; points that stray beyond the divergence threshold
// turn signal orange, get a direct label, and become evidence doors. Where
// two instruments disagree is exactly where reading begins.
//
//   render(container, points, opts) → { element, update, destroy }
//   layoutScatter(points, opts)     → pure geometry
//
// points: [{ x, y, label?, id? }] — id wires data-evidence
// opts: { xLabel, yLabel, threshold (|x−y| → divergent, default 0.25), domain }

import { svgEl } from "../../dom.js";
import { linearScale, niceDomain, extent } from "./scale.js";
import { chartFigure, observeWidth, svgRoot, dataTable, fitLabel } from "./chartkit.js";
import { fmt } from "../../format.js";

/* ---- pure geometry ------------------------------------------------------- */
export function layoutScatter(points, {
  width = 420,
  height = 320,
  padLeft = 48,
  padRight = 16,
  padTop = 12,
  padBottom = 36,
  domain = null,        // one shared domain for both axes (triangulation reads square)
  threshold = 0.25,
} = {}) {
  const all = points.flatMap((p) => [p.x, p.y]);
  const d = domain ?? niceDomain(extent(all), 4);
  const sx = linearScale(d, [padLeft, width - padRight]);
  const sy = linearScale(d, [height - padBottom, padTop]);

  const pts = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({
      cx: sx(p.x), cy: sy(p.y),
      x: p.x, y: p.y,
      label: p.label, id: p.id,
      divergence: Math.abs(p.x - p.y),
      divergent: Math.abs(p.x - p.y) > threshold,
    }));

  return {
    width, height,
    domain: d,
    x: sx, y: sy,
    identity: { x1: sx(d[0]), y1: sy(d[0]), x2: sx(d[1]), y2: sy(d[1]) },
    xTicks: sx.ticks(4).map((t) => ({ value: t, x: sx(t) })),
    yTicks: sy.ticks(4).map((t) => ({ value: t, y: sy(t) })),
    baselineY: height - padBottom,
    baselineX: padLeft,
    points: pts,
    divergentCount: pts.filter((p) => p.divergent).length,
  };
}

export function toTable(points, { caption = "Triangulation data", xLabel = "x", yLabel = "y", format = (v) => fmt(v, 2), threshold = 0.25 } = {}) {
  return dataTable(caption,
    ["", xLabel, yLabel, "|Δ|", "divergent"],
    points.map((p, i) => [
      p.label ?? p.id ?? `#${i + 1}`,
      format(p.x), format(p.y),
      format(Math.abs(p.x - p.y)),
      Math.abs(p.x - p.y) > threshold ? "yes" : "",
    ]));
}

export function render(container, points, opts = {}) {
  const {
    caption = null,
    xLabel = "Instrument A",
    yLabel = "Instrument B",
    format = (v) => fmt(v, 2),
    threshold = 0.25,
    height = 320,
  } = opts;

  const { figure, mount } = chartFigure({
    caption,
    table: toTable(points, { caption: caption ?? "Triangulation data", xLabel, yLabel, format, threshold }),
    chartClass: "chart--scatter",
  });
  container.append(figure);

  let current = points;

  const destroyResize = observeWidth(mount, (width, first) => {
    mount.replaceChildren(draw(current, Math.min(width, 560), first));
  });

  function draw(p, width, first) {
    const g = layoutScatter(p, { ...opts, width, height, threshold });
    const svg = svgRoot(g.width, g.height, caption ?? `${yLabel} against ${xLabel}`);
    if (first) svg.classList.add("chart--draw");

    // identity diagonal — agreement's resting line
    svg.append(svgEl("line", {
      x1: g.identity.x1, y1: g.identity.y1, x2: g.identity.x2, y2: g.identity.y2,
      class: "chart__identity",
    }));

    const axis = svgEl("g", { class: "chart__axis" });
    axis.append(
      svgEl("line", { x1: g.baselineX, y1: g.baselineY, x2: g.x.range[1], y2: g.baselineY, class: "chart__baseline" }),
      svgEl("line", { x1: g.baselineX, y1: g.y.range[1], x2: g.baselineX, y2: g.baselineY, class: "chart__baseline" }),
    );
    for (const t of g.xTicks) {
      axis.append(svgEl("text", { x: t.x, y: g.baselineY + 14, class: "chart__tick", "text-anchor": "middle" }, format(t.value)));
    }
    for (const t of g.yTicks) {
      axis.append(svgEl("text", { x: g.baselineX - 8, y: t.y, class: "chart__tick", "text-anchor": "end", "dominant-baseline": "middle" }, format(t.value)));
    }
    axis.append(
      svgEl("text", { x: (g.baselineX + g.x.range[1]) / 2, y: g.height - 4, class: "chart__axislabel", "text-anchor": "middle" }, xLabel),
      svgEl("text", {
        x: 12, y: (g.y.range[0] + g.y.range[1]) / 2, class: "chart__axislabel",
        "text-anchor": "middle", transform: `rotate(-90 12 ${(g.y.range[0] + g.y.range[1]) / 2})`,
      }, yLabel),
    );
    svg.append(axis);

    g.points.forEach((pt, i) => {
      const dot = svgEl("circle", {
        cx: pt.cx, cy: pt.cy, r: pt.divergent ? 4 : 3,
        class: `chart__point${pt.divergent ? " chart__point--divergent" : ""}`,
        style: `--i:${i}`,
        ...(pt.id
          ? { "data-evidence": pt.id, tabindex: "0", role: "button",
              "aria-label": `${pt.label ?? pt.id}: ${xLabel} ${format(pt.x)}, ${yLabel} ${format(pt.y)} — open evidence` }
          : {}),
      });
      svg.append(dot);
      if (pt.divergent && pt.label) {
        svg.append(svgEl("text", {
          x: pt.cx + 7, y: pt.cy - 6, class: "chart__pointlabel",
        }, fitLabel(pt.label, 90)));
      }
    });

    return svg;
  }

  return {
    element: figure,
    update(next) {
      current = next;
      mount.replaceChildren(draw(current, Math.min(mount.clientWidth || 420, 560), false));
      figure.querySelector(".chart__data table")
        ?.replaceWith(toTable(current, { caption: caption ?? "Triangulation data", xLabel, yLabel, format, threshold }));
    },
    destroy() {
      destroyResize();
      figure.remove();
    },
  };
}
