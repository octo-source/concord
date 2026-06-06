// Pipeline strip — the connective tissue between the five stations of a
// measurement: Construct → Instrument → Run → Calibrate → Corrected. One
// quiet line (overline typography) that says where this artifact sits, plus
// ONE wired next action. Guidance, not chrome: the screens compute the
// per-stage states; this only renders them.

import { el } from "../dom.js";

export const STAGES = [
  { key: "construct", label: "Construct" },
  { key: "instrument", label: "Instrument" },
  { key: "run", label: "Run" },
  { key: "calibrate", label: "Calibrate", mark: "●" },
  { key: "corrected", label: "Corrected", mark: "◉" },
];

/**
 * render({ current, states, action }) → <nav class="pipeline">
 *   current  stage key — stages before it default to "done", it to "current",
 *            after it to "next"
 *   states   per-stage overrides: {run: "done", calibrate: "locked", …}
 *   action   the ONE next step: {label, href} or {label, onclick}
 */
export function render({ current, states = {}, action = null } = {}) {
  const ci = STAGES.findIndex((s) => s.key === current);
  const items = STAGES.map((s, i) => {
    const state = states[s.key] ?? (i < ci ? "done" : i === ci ? "current" : "next");
    return el("li", {
      class: `pipeline__stage pipeline__stage--${state}`,
      aria: { current: state === "current" ? "step" : null },
    },
      s.label,
      state === "done" ? el("span", { class: "pipeline__tick", aria: { hidden: "true" } }, "✓") : null,
      s.mark ? el("span", { class: "pipeline__mark", aria: { hidden: "true" } }, s.mark) : null,
    );
  });

  let go = null;
  if (action?.href) {
    go = el("a", { class: "btn btn--quiet pipeline__go", href: action.href }, action.label);
  } else if (typeof action?.onclick === "function") {
    go = el("button", { class: "btn btn--quiet pipeline__go", type: "button", onclick: action.onclick }, action.label);
  }

  return el("nav", { class: "pipeline", aria: { label: "Measurement pipeline" } },
    el("ol", { class: "pipeline__stages", role: "list" }, ...items),
    go,
  );
}
