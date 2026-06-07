// Citation chips — wherever the product leans on advice from the methods
// literature (benchmark bands, sample-size guidance, correction estimators),
// the source is named at the point of use. cite(key) renders a superscript
// reference chip: short author–year text, full citation in a hover/focus
// popover and in the aria-label, so the claim is checkable without leaving
// the screen. Unknown keys render visibly (never silently dropped) so a typo
// cannot pass review.

import { el } from "../dom.js";

/** key → {short, full}. The full string is the tooltip and the aria text. */
export const CITATIONS = {
  krippendorff2004: {
    short: "Krippendorff 2004",
    full: "Krippendorff, K. (2004). Content Analysis. α ≥ .800 for confident conclusions; .667–.800 for tentative ones.",
  },
  landiskoch1977: {
    short: "Landis & Koch 1977",
    full: "Landis, J.R. & Koch, G.G. (1977). Biometrics 33: κ .61–.80 'substantial', .81–1.00 'almost perfect'.",
  },
  cohen1960: {
    short: "Cohen 1960",
    full: "Cohen, J. (1960). A coefficient of agreement for nominal scales. Educational and Psychological Measurement 20(1).",
  },
  gwet2014: {
    short: "Gwet 2014",
    full: "Gwet, K.L. (2014). Handbook of Inter-Rater Reliability, 4th ed. — AC1 under prevalence paradoxes.",
  },
  egami2023: {
    short: "Egami et al. 2023",
    full: "Egami, Hinck, Stewart & Wei (2023). Design-based supervised learning. NeurIPS 36.",
  },
  angelopoulos2023: {
    short: "Angelopoulos et al. 2023",
    full: "Angelopoulos et al. (2023). Prediction-powered inference. Science 382.",
  },
  donner1992: {
    short: "Donner & Eliasziw 1992",
    full: "Donner, A. & Eliasziw, M. (1992). A goodness-of-fit approach to inference procedures for the kappa statistic: confidence interval construction, significance-testing and sample size estimation. Statistics in Medicine 11.",
  },
};

/**
 * cite(key) → <sup class="cite"> reference chip.
 * Focusable (keyboard users get the popover too); the full citation rides in
 * aria-label and title, the popover is aria-hidden so screen readers hear the
 * citation exactly once.
 */
export function cite(key) {
  const def = CITATIONS[key];
  if (!def) {
    // a missing key is a defect — show it, never swallow it
    return el("sup", { class: "cite cite--unknown", title: `unknown citation key "${key}"` }, `[${key}?]`);
  }
  return el("sup", { class: "cite" },
    el("span", {
      class: "cite__chip",
      tabindex: "0",
      role: "note",
      title: def.full,
      aria: { label: `Citation: ${def.full}` },
    },
      def.short,
      el("span", { class: "cite__pop", aria: { hidden: "true" } }, def.full)));
}

/** Several keys in one breath: citeAll("cohen1960", "donner1992"). */
export function citeAll(...keys) {
  return keys.map((k) => cite(k));
}
