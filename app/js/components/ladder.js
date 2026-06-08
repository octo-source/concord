// The evidence-ladder mark — ◌ ◑ ● ◉ — worn by every number in the product.
// Non-interactive marks are quiet glyphs with a hover/focus popover that
// explains the level; when a level-up affordance is provided the mark becomes
// a button whose popover carries the offer and its honest price
// ("Calibrate → ● · ~150 units, ~35 min"). Levels never gate anything.

import { el } from "../dom.js";

export const LEVELS = {
  exploratory: {
    mark: "◌",
    name: "Exploratory",
    tip: "Compiles and runs. Not yet checked against human labels. Treat results as a draft; exported results keep an exploratory watermark.",
    next: "stabilized",
  },
  stabilized: {
    mark: "◑",
    name: "Stabilized",
    tip: "Consistent with itself: passed the test–retest stability check and silver calibration. Not yet compared with human judgment.",
    next: "calibrated",
  },
  calibrated: {
    mark: "●",
    name: "Calibrated",
    tip: "Agreement against human gold labels is attached, and the instrument is frozen — any edit forks a new version.",
    next: "corrected",
  },
  corrected: {
    mark: "◉",
    name: "Corrected",
    tip: "Computed with design-based correction (DSL/PPI) against the gold sample. Machine error cannot bias this number; it can only widen its confidence interval.",
    next: null,
  },
};

export const ORDER = ["exploratory", "stabilized", "calibrated", "corrected"];

/** Normalize "●"/index/name → level key. */
export function levelKey(level) {
  if (typeof level === "number") return ORDER[Math.max(0, Math.min(3, level))];
  const s = String(level ?? "exploratory").toLowerCase();
  if (LEVELS[s]) return s;
  const byMark = ORDER.find((k) => LEVELS[k].mark === level);
  return byMark ?? "exploratory";
}

/**
 * render({ level, label?, size?, levelUp? }) → <span|button class="ladder">
 *   level    "exploratory"|"stabilized"|"calibrated"|"corrected" (or mark/index)
 *   label    true → show the level name beside the mark
 *   size     "sm" (inline with data, default) | "md" | "lg"
 *   levelUp  { price: "~150 units, ~35 min", onLevelUp(currentLevel) } —
 *            renders as a button; the popover carries the offer.
 */
export function render({ level = "exploratory", label = false, size = "sm", levelUp = null } = {}) {
  const key = levelKey(level);
  const def = LEVELS[key];
  const interactive = levelUp && typeof levelUp.onLevelUp === "function" && def.next;

  // purely visual — the same text is carried in the host's aria-label, so the
  // popover is hidden from the tree (otherwise it pollutes button names)
  const popover = el("span", { class: "ladder__pop", role: "tooltip", aria: { hidden: "true" } },
    el("span", { class: "ladder__pop-name" }, `${def.mark} ${def.name}`),
    el("span", { class: "ladder__pop-tip" }, def.tip),
    interactive
      ? el("span", { class: "ladder__pop-offer" },
          el("span", { class: "ladder__pop-action" },
            `${actionVerb(def.next)} → ${LEVELS[def.next].mark}`),
          levelUp.price ? el("span", { class: "ladder__pop-price data" }, levelUp.price) : null)
      : null,
  );

  const children = [
    el("span", { class: "ladder__mark", aria: { hidden: "true" } }, def.mark),
    label ? el("span", { class: "ladder__label" }, def.name) : null,
    popover,
  ];

  if (interactive) {
    const priceText = levelUp.price ? ` — ${levelUp.price}` : "";
    return el("button", {
      class: `ladder ladder--${key} ladder--${size} ladder--up`,
      type: "button",
      dataset: { level: key },
      aria: { label: `Evidence level: ${def.name}. ${actionVerb(def.next)} to ${LEVELS[def.next].name}${priceText}.` },
      onclick: (e) => { e.stopPropagation(); levelUp.onLevelUp(key); },
    }, ...children);
  }

  // sm marks ride inline beside data values — making each one a tab stop
  // would pollute keyboard travel through tables and the rail, so only
  // standalone (md/lg) marks take focus; the tip always reads via aria-label.
  return el("span", {
    class: `ladder ladder--${key} ladder--${size}`,
    dataset: { level: key },
    role: "img",
    tabindex: size === "sm" ? null : "0",
    aria: { label: `Evidence level: ${def.name}. ${def.tip}` },
  }, ...children);
}

function actionVerb(nextKey) {
  return { stabilized: "Stabilize", calibrated: "Calibrate", corrected: "Correct" }[nextKey] ?? "Level up";
}

/** Bare mark string for inline text composition ("0.42 ◉"). */
export function mark(level) {
  return LEVELS[levelKey(level)].mark;
}
