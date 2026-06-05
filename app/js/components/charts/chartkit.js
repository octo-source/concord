// Shared chart plumbing: the figure shell (SVG + caption + the accessible
// data-table twin), resize awareness, the draw-in choreography (150ms,
// FIRST render only — recomposition is instant), and the SVG hatch
// convention for "uncorrected".
//
// HATCH CONVENTION — every chart that shows an uncorrected/naive series
// calls hatchPattern(svg) once; it appends a <defs><pattern> of 45° hairlines
// stroked in currentColor and returns its url(#id). Fills inherit whatever
// ink the series carries (machine blue by default), in both themes, with no
// hard-coded color in the pattern itself.

import { el, svgEl, uid } from "../../dom.js";

/**
 * chartFigure({ caption, table, chartClass }) → { figure, mount }
 * The figure holds: the chart mount, a quiet caption line, and a
 * <details> twin ("data") containing the real <table> — visually present
 * on demand, always in the accessibility tree via the summary.
 */
export function chartFigure({ caption, table, chartClass = "" } = {}) {
  const mount = el("div", { class: `chart__mount ${chartClass}`.trim() });
  const figure = el("figure", { class: "chart" },
    mount,
    caption ? el("figcaption", { class: "chart__caption" }, caption) : null,
    table
      ? el("details", { class: "chart__data" },
          el("summary", { class: "chart__data-summary" }, "data"),
          table)
      : null,
  );
  return { figure, mount };
}

/** Append the uncorrected-hatch <pattern> to an svg; returns "url(#…)". */
export function hatchPattern(svg, { spacing = 5, strokeWidth = 1.1 } = {}) {
  const id = uid("hatch");
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = svgEl("defs");
    svg.prepend(defs);
  }
  defs.append(
    svgEl("pattern", {
      id,
      patternUnits: "userSpaceOnUse",
      width: spacing,
      height: spacing,
      patternTransform: "rotate(45)",
    },
      svgEl("line", {
        x1: 0, y1: 0, x2: 0, y2: spacing,
        stroke: "currentColor",
        "stroke-width": strokeWidth,
        opacity: 0.65,
      })),
  );
  return `url(#${id})`;
}

/**
 * Observe a mount's width; calls draw(width, firstRender) synchronously now
 * and again whenever the width actually changes. Returns destroy().
 *
 * The first composition NEVER waits on requestAnimationFrame: rAF stalls in
 * background/hidden documents, and charts are often rendered into detached
 * fragments. A detached mount composes at the 600px fallback; the
 * ResizeObserver re-draws at true width the moment layout assigns one (the
 * width guard makes the callback self-quieting, so replaceChildren inside
 * draw() cannot loop it).
 */
export function observeWidth(mount, draw) {
  let first = true;
  let lastWidth = -1;

  const run = () => {
    const width = Math.max(0, mount.clientWidth);
    if (width === lastWidth && !first) return;
    lastWidth = width;
    draw(width || 600, first);
    first = false;
  };

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(run) : null;
  ro?.observe(mount);
  run();

  return () => ro?.disconnect();
}

/** Standard svg root: role=img + label, viewBox sized, .chart__svg. */
export function svgRoot(width, height, label) {
  return svgEl("svg", {
    class: "chart__svg",
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height,
    role: "img",
    "aria-label": label,
    preserveAspectRatio: "xMinYMin meet",
  });
}

/** Build the visually-available data-table twin from headers + rows. */
export function dataTable(caption, headers, rows) {
  return el("table", { class: "chart__table" },
    el("caption", { class: "sr-only" }, caption),
    el("thead", {},
      el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {},
      ...rows.map((cells) =>
        el("tr", {}, ...cells.map((c, i) =>
          i === 0 ? el("th", { scope: "row" }, String(c)) : el("td", { class: "data" }, String(c)))))),
  );
}

/** Truncate a label to fit a pixel budget at ~6.6px/char (11px mono). */
export function fitLabel(text, maxPx, pxPerChar = 6.6) {
  const s = String(text ?? "");
  const maxChars = Math.max(3, Math.floor(maxPx / pxPerChar));
  return s.length <= maxChars ? s : s.slice(0, maxChars - 1) + "…";
}
