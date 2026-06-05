// Small multiples — a grid that composes ANY chart renderer over a list of
// datasets, one quiet mono title per panel, optionally on a shared domain so
// the eye can compare across panels without re-reading axes.
//
//   render(container, { items, renderFn, opts, columns, sharedDomain })
//     items        [{ title, data }]
//     renderFn     a chart module's render (bar.render, line.render, …)
//     opts         passed to every panel's renderFn
//     columns      fixed column count (default: auto-fit ~240px panels)
//     sharedDomain true → compute one numeric domain across all panels and
//                  pass it as opts.domain (panels must accept opts.domain)
//     domainOf     (data) → number[] — values used for the shared domain;
//                  default handles bar-style [{value}] arrays.
//
// → { element, charts: [controller…], destroy }

import { el } from "../../dom.js";
import { niceDomain, extent } from "./scale.js";

export function render(container, {
  items = [],
  renderFn,
  opts = {},
  columns = null,
  sharedDomain = false,
  domainOf = defaultDomainOf,
  caption = null,
} = {}) {
  const grid = el("div", {
    class: "smallmultiples",
    style: columns ? { "--sm-cols": String(columns) } : undefined,
    role: "group",
    aria: { label: caption ?? "Small multiples" },
  });

  let panelOpts = { ...opts };
  if (sharedDomain && items.length > 0) {
    const all = items.flatMap((item) => domainOf(item.data));
    panelOpts.domain = niceDomain(extent([0, ...all]), 4);
  }

  const charts = [];
  for (const item of items) {
    const panel = el("section", { class: "smallmultiples__panel" },
      el("h4", { class: "smallmultiples__title data" }, item.title),
    );
    grid.append(panel);
    charts.push(renderFn(panel, item.data, { ...panelOpts, caption: null }));
  }

  const figure = caption
    ? el("figure", { class: "smallmultiples__figure" }, grid,
        el("figcaption", { class: "chart__caption" }, caption))
    : grid;
  container.append(figure);

  return {
    element: figure,
    charts,
    destroy() {
      for (const c of charts) c.destroy?.();
      figure.remove();
    },
  };
}

/** Default domain extractor: bar-style rows ({value} or {corrected,naive}). */
export function defaultDomainOf(data) {
  if (!Array.isArray(data)) return [];
  return data.flatMap((d) => {
    if (typeof d?.value === "number") return [d.value, ...(d.ci ?? [])];
    const out = [];
    if (typeof d?.corrected?.value === "number") out.push(d.corrected.value, ...(d.corrected.ci ?? []));
    if (typeof d?.naive?.value === "number") out.push(d.naive.value);
    if (Array.isArray(d?.points)) out.push(...d.points.map((p) => p.y));
    return out;
  });
}
