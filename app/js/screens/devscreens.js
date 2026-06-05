// Dev screens index — #/dev/screens — the acceptance surface for the screens
// wave. With ?fixtures=1 every screen renders from app/fixtures/*.json and no
// server. Each row: the screen, its route with fixture ids filled in, and the
// one-line acceptance it should meet. The toggle persists fixtures mode.

import { el } from "../dom.js";
import { fixturesEnabled, setFixtures, isInstalled } from "../fixtures.js";
import { screenHead, section } from "./_shared.js";

export const route = "dev/screens";
export const title = "Screens index";

const SLUG = "techcorp-exit";

const SCREENS = [
  ["Projects home", "#/", "project cards with ladder summary; new-project sheet (name + privacy mode)"],
  ["Import", `#/p/${SLUG}/import`, "drop/pick a file → column role chips with confidence, 20-row preview, gentle issues, unitization advice ✦, junk queue, one Confirm → Instant Read"],
  ["Instant Read", `#/p/${SLUG}/corpus/corp_exit2025/instant`, "renders <1s: length hist, language mix, distinctive terms, VADER sketch, metadata small multiples; all-local badge; cost-labeled Brief CTA"],
  ["Corpus Brief (stream)", `#/p/${SLUG}/brief/new?corpus=corp_exit2025`, "paragraphs stream in over SSE with margin quote-pulls; refs are inspector doors"],
  ["Corpus Brief (stored)", `#/p/${SLUG}/brief/brief_a1`, "reading column ~68ch; themes with Explore action (estimate chips); red flags as annotations; Director byline ✦"],
  ["Explorer", `#/p/${SLUG}/explore/run_panel_full`, "prevalence bars ◌ with data-evidence; Director-flagged cross-tabs with dismissible annotations; co-occurrence heat; calibration nudge with price"],
  ["Constructs", `#/p/${SLUG}/constructs/k_theme`, "structured editor; categories with explicit order; worked examples with kind chips; glyph dissolves on first edit; import/inductive flows"],
  ["Instruments — dictionary", `#/p/${SLUG}/instruments/inst_dict`, "term chips, weights, negation toggle+window, live highlighted preview on sample units"],
  ["Instruments — judge ◌", `#/p/${SLUG}/instruments/inst_judge_x`, "compiled prompt with slot highlighting; workerClass; model picker; raw escape hatch; actions row"],
  ["Instruments — judge ◑", `#/p/${SLUG}/instruments/inst_judge_s`, "stability badge; silver-tune SSE iteration cards + curve"],
  ["Instruments — frozen ●", `#/p/${SLUG}/instruments/inst_judge_f`, "read-only with calibration certificate (κ, CI, per-class, version hash)"],
  ["Instruments — panel", `#/p/${SLUG}/instruments/inst_panel`, "juror cards with family chips; live cost-per-1k; family-disjointness warning; aggregation in plain language"],
  ["Calibration Studio", `#/p/${SLUG}/goldsets/g_theme1`, "Sample (design, n, π note) · Code (full-bleed sprint: j/k, 1–9, f, m, timer, quiet completion) · Test (human-first banner + band, per-instrument nested agreement with confusion heat-tables) · Adjudicate (derived queue, pick-or-enter)"],
  ["Runs (list + preflight)", `#/p/${SLUG}/runs`, "preflight sheet: units × calls → tokens → $ ±15%, ETA, privacy ✓, budget remaining, hard cap → Start"],
  ["Run monitor (live)", `#/p/${SLUG}/runs/run_judge_pre`, "start from preflight to watch ticks: progress, running cost, label dist accumulating, warnings, escalations; pause/resume/abort"],
  ["Run (complete)", `#/p/${SLUG}/runs/run_panel_full`, "summary + escalation queue with worker vs Director rationale pairs; Explore handoff"],
  ["Workbench — crosstab ◉", `#/p/${SLUG}/analyses/an_crosstab`, "crosstab with χ²/p/min-expected; THE CORRECTION REVEAL: solid ◉ + CI beside hatched naive, Δ annotated, one-line DSL explainer"],
  ["Workbench — triangulation", `#/p/${SLUG}/analyses/an_triang`, "instrument-vs-instrument agreement (n, %, κ) + divergence browser into the inspector"],
  ["Workbench — subgroup", `#/p/${SLUG}/analyses/an_subgroup`, "label distribution by metadata group; corrected ◉ cells where the gold sample reaches"],
  ["Workbench — model", `#/p/${SLUG}/analyses/an_model`, "coefficient table with se=0 null-handling note; naive comparison behind a reveal"],
  ["Disagreement", `#/p/${SLUG}/runs/run_panel_full/disagreement`, "entropy-ranked list; juror×juror heat; facing rationale columns; route-to-human / codebook-defect dispositions"],
  ["Reports", `#/p/${SLUG}/reports`, "methods with hoverable [ledger:…] citation chips + .md export; replication contents + gold-text toggle; block canvas → standalone HTML"],
  ["Settings (project)", `#/p/${SLUG}/settings`, "provider cards (masked keys, reachability dots), catalog browser, Director slot, privacy downgrade confirmation, budget, theme"],
  ["Settings (global)", "#/settings", "same surface without the project-scoped privacy/budget sections"],
];

export function render(mount) {
  const on = fixturesEnabled();

  mount.append(screenHead({
    overline: "Development",
    title: "Every screen, one index.",
    lede: on
      ? `Fixtures mode is ON${isInstalled() ? " and installed" : " (reload to install)"} — every route below renders from app/fixtures/*.json with no server.`
      : "Fixtures mode is OFF — routes hit the live server. Turn it on to review the screens without one.",
    actions: [
      el("button", {
        class: "btn" + (on ? "" : " btn--primary"), type: "button",
        onclick: () => {
          setFixtures(!on);
          // reload so the adapter installs before any api call
          const base = location.href.split("?")[0];
          location.href = base + (!on ? "?fixtures=1" : "?fixtures=0");
          location.reload();
        },
      }, on ? "Turn fixtures OFF (reload)" : "Turn fixtures ON (reload)"),
    ],
  }));

  mount.append(section("The twelve screens (and their variants)",
    el("ol", { class: "devlist", role: "list" },
      ...SCREENS.map(([name, href, acceptance]) =>
        el("li", { class: "devrow" },
          el("a", { class: "devrow__link", href },
            el("span", { class: "devrow__name" }, name),
            el("code", { class: "devrow__route data" }, href)),
          el("p", { class: "devrow__acceptance faint" }, acceptance))))));

  mount.append(el("p", { class: "screen__footnote faint" },
    "Keyboard everywhere: ", el("kbd", {}, "/"), " focuses the Question Bar · ",
    el("kbd", {}, "Esc"), " closes the inspector and sheets · the coding sprint runs entirely on ",
    el("kbd", {}, "j"), el("kbd", {}, "k"), el("kbd", {}, "1"), "–", el("kbd", {}, "9"),
    el("kbd", {}, "f"), el("kbd", {}, "m"), "."));
}
