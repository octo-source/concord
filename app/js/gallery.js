import { el } from "./dom.js";
import * as ladder from "./components/ladder.js";
import * as glyph from "./components/glyph.js";
import * as quotecard from "./components/quotecard.js";
import * as rail from "./components/rail.js";
import * as inspector from "./components/inspector.js";
import * as table from "./components/table.js";
import * as confusion from "./components/confusion.js";
import * as toast from "./components/toast.js";
import * as bar from "./components/charts/bar.js";
import * as line from "./components/charts/line.js";
import * as scatter from "./components/charts/scatter.js";
import * as heat from "./components/charts/heat.js";
import * as smallmultiples from "./components/charts/smallmultiples.js";
import { fmtStat, fmtCount } from "./format.js";

const $ = (id) => document.getElementById(id);

/* ---- theme frames load only at the top level (recursion guard) ---- */
if (!document.documentElement.hasAttribute("data-embed")) {
  for (const f of document.querySelectorAll(".theme-frames iframe[data-src]")) {
    f.src = f.dataset.src;
  }
}

/* ---- theme toggle ---- */
$("theme-toggle")?.addEventListener("click", () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  if (dark) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", "dark");
  try {
    localStorage.setItem("concord-theme", dark ? "light" : "dark");
  } catch {
    /* storage unavailable */
  }
});

/* ---- swatches ---- */
const SWATCHES = [
  ["ground", "--ground"],
  ["raised", "--paper-raised"],
  ["recessed", "--paper-recessed"],
  ["ink", "--ink"],
  ["ink muted", "--ink-muted"],
  ["accent (teal)", "--accent"],
  ["gold — human", "--gold"],
  ["machine — blue", "--machine"],
  ["signal — disagreement", "--signal"],
];
const css = getComputedStyle(document.documentElement);
$("swatches").append(
  ...SWATCHES.map(([name, varName]) =>
    el(
      "div",
      { class: "swatch" },
      el("div", { class: "swatch__color", style: { background: `var(${varName})` } }),
      el("div", { class: "swatch__name" }, name),
      el("div", { class: "swatch__hex" }, css.getPropertyValue(varName).trim() || varName),
    ),
  ),
);

/* ---- ladder ---- */
$("ladder-states").append(
  ...["exploratory", "stabilized", "calibrated", "corrected"].map((level) =>
    el("div", {}, ladder.render({ level, label: true, size: "lg" })),
  ),
);
$("ladder-inline").append(
  ladder.render({
    level: "exploratory",
    size: "sm",
    levelUp: {
      price: "~150 units, ~35 min",
      onLevelUp: () =>
        toast.info("Calibration Studio would open here.", {
          detail: "Sample → code → test → freeze",
        }),
    },
  }),
);

/* ---- glyph ---- */
$("glyph-drafted").append(glyph.render({ authoredBy: "director", humanTouched: false }));
const liveGlyph = glyph.render({ authoredBy: "director", humanTouched: false });
$("glyph-live").append(liveGlyph);
$("adopt-btn").addEventListener("click", () => {
  glyph.update(liveGlyph, { humanTouched: true });
  toast.success("Adopted — now yours to edit.", { duration: 3000 });
});

/* ---- quotes ---- */
const QUOTE_EN = {
  unit: {
    id: "u_2847f1a09c3d55b2",
    text: "I stayed three years longer than I should have. The pay was fine, honestly — it was watching every good manager leave while the broken processes stayed. By the end I was doing two jobs and interviewing for a third.",
    meta: { dept: "Operations", tenure_years: 5, satisfaction: 2 },
    pos: { row: 2847 },
  },
  highlights: [
    { start: 52, end: 55, category: "pay" },
    { start: 104, end: 111, category: "management" },
    { start: 176, end: 184, category: "workload" },
  ],
  gold: "management",
};
$("quote-en").append(quotecard.render(QUOTE_EN));

$("quote-es").append(
  quotecard.render({
    unit: {
      id: "u_91b3c07d2e8f4a16",
      text: "El salario nunca alcanzó y la gerencia jamás escuchaba; aun así, voy a extrañar muchísimo a mi equipo.",
      meta: { dept: "Ventas", tenure_years: 3, region: "LATAM" },
      pos: { row: 1093 },
    },
    highlights: [
      { start: 3, end: 10, category: "pay" },
      { start: 30, end: 38, category: "management" },
    ],
    lang: "es",
  }),
);

$("quote-pii").append(
  quotecard.render({
    unit: {
      id: "u_55e0a9d4b7c2f311",
      text: "My director ⟨NAME_1⟩ promised a promotion for two cycles running. I believed ⟨NAME_1⟩ both times. That is on me.",
      meta: { dept: "Engineering", tenure_years: 4 },
      pos: { row: 412 },
    },
    highlights: [
      { start: 12, end: 20, kind: "pii" },
      { start: 77, end: 85, kind: "pii" },
      { start: 32, end: 41, category: "growth" },
    ],
    anonymized: true,
  }),
);

/* ---- rail ---- */
$("rail-full").append(
  rail.render({
    sections: [
      {
        id: "corpora",
        title: "Corpora",
        items: [{ id: "c1", label: "techcorp-exit-survey", count: 2500 }],
      },
      {
        id: "constructs",
        title: "Constructs",
        items: [
          { id: "k1", label: "Pay & compensation" },
          {
            id: "k2",
            label: "Management quality",
            authoredBy: "director",
            humanTouched: false,
          },
          { id: "k3", label: "Workload & burnout" },
        ],
      },
      {
        id: "instruments",
        title: "Instruments",
        items: [
          { id: "i1", label: "pay · dictionary", level: "stabilized" },
          { id: "i2", label: "management · judge", level: "calibrated" },
          { id: "i3", label: "burnout · panel ×3", level: "exploratory" },
        ],
      },
      {
        id: "runs",
        title: "Runs",
        items: [{ id: "r1", label: "run_mgmt-full", count: 2500 }],
      },
      {
        id: "analyses",
        title: "Analyses",
        items: [
          { id: "a1", label: "pay × dept (DSL)", level: "corrected" },
          { id: "a2", label: "burnout trend", level: "exploratory" },
        ],
      },
    ],
    activeId: "i2",
    onSelect: (item) => toast.info(`Rail → ${item.label}`, { duration: 1800 }),
  }),
);
$("rail-empty").append(rail.render({})); // all five sections, empty hints

/* ---- table ---- */
const tableRows = [
  {
    name: "judge · claude-haiku",
    kappa: 0.82,
    alpha: 0.79,
    f1: 0.86,
    n: 150,
    level: "calibrated",
    id: "u_2847f1a09c3d55b2",
  },
  {
    name: "dictionary · work-themes",
    kappa: 0.61,
    alpha: 0.58,
    f1: 0.7,
    n: 150,
    level: "stabilized",
    id: "u_91b3c07d2e8f4a16",
  },
  {
    name: "panel ×3 · majority",
    kappa: 0.87,
    alpha: 0.85,
    f1: 0.9,
    n: 150,
    level: "calibrated",
    id: "u_55e0a9d4b7c2f311",
  },
  {
    name: "judge · gpt-mini",
    kappa: 0.74,
    alpha: 0.71,
    f1: 0.8,
    n: 150,
    level: "exploratory",
    id: "u_8800c1d2e4a90b77",
  },
];
$("table-demo").append(
  table.render({
    caption: "Instruments against gold — management construct",
    showCaption: true,
    columns: [
      { key: "name", label: "Instrument" },
      {
        key: "kappa",
        label: "κ",
        numeric: true,
        format: (v) => fmtStat(v),
        level: (r) => r.level,
        evidence: (r) => r.id,
      },
      {
        key: "alpha",
        label: "α",
        numeric: true,
        format: (v) => fmtStat(v),
        level: (r) => r.level,
      },
      { key: "f1", label: "F1", numeric: true, format: (v) => fmtStat(v) },
      { key: "n", label: "n", numeric: true, format: (v) => fmtCount(v) },
    ],
    rows: tableRows,
    sort: { key: "kappa", dir: "desc" },
  }),
);
$("table-empty").append(
  table.render({
    caption: "Escalation queue",
    columns: [
      { key: "unit", label: "Unit" },
      { key: "reason", label: "Reason" },
      { key: "conf", label: "conf", numeric: true },
    ],
    rows: [],
    empty: {
      title: "No escalations.",
      hint: "Low-confidence and high-entropy units will queue here for the Director's second opinion.",
    },
  }),
);

/* ---- confusion ---- */
$("confusion-demo").append(
  confusion.render({
    labels: ["pay", "management", "workload"],
    matrix: [
      [34, 3, 1],
      [4, 28, 2],
      [2, 5, 21],
    ],
    evidence: {
      "0,0": ["u_2847f1a09c3d55b2", "u_91b3c07d2e8f4a16"],
      "0,1": ["u_55e0a9d4b7c2f311"],
      "1,0": ["u_8800c1d2e4a90b77", "u_2847f1a09c3d55b2", "u_91b3c07d2e8f4a16"],
      "1,1": ["u_2847f1a09c3d55b2"],
      "1,2": ["u_8800c1d2e4a90b77"],
      "2,2": ["u_55e0a9d4b7c2f311"],
    },
    caption: "judge · claude-haiku vs adjudicated gold (n = 100)",
  }),
);

/* ---- charts ---- */
bar.render(
  $("chart-bars"),
  [
    { label: "pay", value: 0.28, evidence: "u_2847f1a09c3d55b2" },
    { label: "workload-burnout", value: 0.25, evidence: "u_91b3c07d2e8f4a16" },
    { label: "management", value: 0.22, evidence: "u_55e0a9d4b7c2f311" },
    { label: "growth", value: 0.18 },
    { label: "remote policy", value: 0.12 },
    { label: "quit-regret", value: 0.06 },
  ],
  {
    caption: "Theme prevalence, full corpus — exploratory (click a row to open evidence)",
    level: "exploratory",
    format: (v) => fmtStat(v),
  },
);

line.render(
  $("chart-line"),
  [
    {
      label: "workload",
      points: [
        { x: 1, y: 0.18 },
        { x: 2, y: 0.21 },
        { x: 3, y: 0.22 },
        { x: 4, y: 0.25 },
        { x: 5, y: 0.28 },
        { x: 6, y: 0.27 },
        { x: 7, y: 0.31 },
        { x: 8, y: 0.33 },
      ],
      emphasis: true,
    },
    {
      label: "pay",
      points: [
        { x: 1, y: 0.3 },
        { x: 2, y: 0.28 },
        { x: 3, y: 0.29 },
        { x: 4, y: 0.27 },
        { x: 5, y: 0.28 },
        { x: 6, y: 0.26 },
        { x: 7, y: 0.27 },
        { x: 8, y: 0.28 },
      ],
    },
  ],
  {
    caption: "Monthly prevalence across the exit cohort",
    formatX: (x) => "M" + x,
    formatY: (v) => fmtStat(v),
    dots: true,
  },
);

scatter.render(
  $("chart-scatter"),
  [
    { x: 0.81, y: 0.78, label: "pay", id: "u_2847f1a09c3d55b2" },
    { x: 0.74, y: 0.71, label: "growth" },
    { x: 0.66, y: 0.62, label: "remote" },
    { x: 0.58, y: 0.6, label: "facilities" },
    { x: 0.52, y: 0.49, label: "benefits" },
    { x: 0.61, y: 0.23, label: "sarcasm-heavy", id: "u_8800c1d2e4a90b77" },
    { x: 0.44, y: 0.47, label: "onboarding" },
    { x: 0.34, y: 0.37, label: "tooling" },
    { x: 0.27, y: 0.62, label: "mixed-lang", id: "u_91b3c07d2e8f4a16" },
    { x: 0.23, y: 0.21, label: "travel" },
    { x: 0.15, y: 0.17, label: "perks" },
    { x: 0.08, y: 0.11, label: "parking" },
  ],
  {
    caption: "Dictionary score vs judge score, by sub-theme — divergence is where reading starts",
    xLabel: "dictionary · work-themes",
    yLabel: "judge · claude-haiku",
    threshold: 0.2,
    format: (v) => fmtStat(v),
  },
);

heat.render(
  $("chart-heat"),
  {
    rows: ["pay", "management", "workload", "growth", "remote"],
    cols: ["pay", "management", "workload", "growth", "remote"],
    values: [
      [0, 31, 18, 22, 9],
      [31, 0, 26, 14, 6],
      [18, 26, 0, 11, 13],
      [22, 14, 11, 0, 4],
      [9, 6, 13, 4, 0],
    ],
  },
  { caption: "Theme co-occurrence (units mentioning both)", format: (v) => String(v) },
);

smallmultiples.render($("chart-sm"), {
  items: [
    {
      title: "Sales",
      data: [
        { label: "pay", value: 0.41 },
        { label: "mgmt", value: 0.18 },
        { label: "workload", value: 0.22 },
      ],
    },
    {
      title: "Engineering",
      data: [
        { label: "pay", value: 0.22 },
        { label: "mgmt", value: 0.24 },
        { label: "workload", value: 0.31 },
      ],
    },
    {
      title: "Operations",
      data: [
        { label: "pay", value: 0.27 },
        { label: "mgmt", value: 0.33 },
        { label: "workload", value: 0.29 },
      ],
    },
    {
      title: "Support",
      data: [
        { label: "pay", value: 0.35 },
        { label: "mgmt", value: 0.21 },
        { label: "workload", value: 0.38 },
      ],
    },
  ],
  renderFn: bar.render,
  sharedDomain: true,
  opts: { format: (v) => fmtStat(v), labelWidth: 76, valueWidth: 56 },
  caption: "Theme prevalence by department — shared scale, compare across panels",
});

/* ---- correction reveal ---- */
bar.render(
  $("chart-paired"),
  [
    {
      label: "Sales",
      corrected: { value: 0.41, ci: [0.35, 0.47] },
      naive: { value: 0.29 },
      evidence: "u_2847f1a09c3d55b2",
    },
    {
      label: "Engineering",
      corrected: { value: 0.22, ci: [0.17, 0.27] },
      naive: { value: 0.19 },
    },
    {
      label: "Operations",
      corrected: { value: 0.31, ci: [0.25, 0.37] },
      naive: { value: 0.36 },
    },
    { label: "Support", corrected: { value: 0.37, ci: [0.3, 0.44] }, naive: { value: 0.33 } },
  ],
  {
    paired: true,
    caption:
      "Mentions of pay by department — DSL-corrected ◉ (solid, 95% CI) beside the naive plug-in (hatched). π stored at sampling; machine accuracy buys precision, never validity.",
    format: (v) => fmtStat(v),
  },
);

/* ---- disagreement pair ---- */
const JUDGE_A = {
  juror: "claude-haiku · v3hash9f2",
  label: "management",
  confidence: 0.84,
  rationale:
    "The pivotal clause is “watching every good manager leave while the broken processes stayed” — an evaluation of leadership stewardship. Pay is explicitly discounted (“the pay was fine”).",
};
const JUDGE_B = {
  juror: "gpt-mini · v3hash2c8",
  label: "workload-burnout",
  confidence: 0.61,
  rationale:
    "“Doing two jobs and interviewing for a third” describes unsustainable load at exit. The manager mention reads as context for the workload, not the complaint itself.",
};
const judgeBlock = (o) =>
  el(
    "div",
    { class: "dossier__judge" },
    el(
      "div",
      { class: "dossier__judge-head" },
      el("span", { class: "chip chip--machine" }, o.label),
      el("span", { class: "dossier__judge-name data" }, o.juror),
      el(
        "span",
        { class: "dossier__judge-conf data" },
        "conf " + fmtStat(o.confidence),
        el("span", {
          class: "confbar",
          style: { "--conf": Math.round(o.confidence * 100) + "%" },
          "aria-hidden": "true",
        }),
      ),
    ),
    el("p", { class: "dossier__rationale" }, o.rationale),
  );
$("disagreement-pair").append(judgeBlock(JUDGE_A), judgeBlock(JUDGE_B));

/* ---- inspector with a full dossier ---- */
const DOSSIER = {
  unit: QUOTE_EN.unit,
  lang: undefined,
  level: "calibrated",
  dictionaryHits: [
    { start: 52, end: 55, category: "pay", term: "pay" },
    { start: 104, end: 111, category: "management", term: "manager" },
    { start: 176, end: 184, category: "workload", term: "two jobs" },
  ],
  outputs: [
    {
      unitId: "u_2847f1a09c3d55b2",
      juror: "claude-haiku·9f2",
      label: "management",
      confidence: 0.84,
      rationale: JUDGE_A.rationale,
    },
    {
      unitId: "u_2847f1a09c3d55b2",
      juror: "gpt-mini·2c8",
      label: "workload-burnout",
      confidence: 0.61,
      rationale: JUDGE_B.rationale,
      escalated: true,
    },
    {
      unitId: "u_2847f1a09c3d55b2",
      juror: "aggregate",
      label: "management",
      confidence: 0.77,
      rationale:
        "Majority of 3 after Director escalation; reliability-weighted agreement favored the management reading.",
    },
  ],
  goldLabels: { pat: "management", sam: "management", adjudicated: "management" },
  sourcePos: { doc: "techcorp-exit-survey.csv", row: 2847, span: [0, 221] },
};

// a small fixture library so every door in this gallery opens something real
const FIXTURES = {
  u_2847f1a09c3d55b2: DOSSIER,
  u_91b3c07d2e8f4a16: {
    unit: {
      id: "u_91b3c07d2e8f4a16",
      text: "El salario nunca alcanzó y la gerencia jamás escuchaba; aun así, voy a extrañar muchísimo a mi equipo.",
      meta: { dept: "Ventas" },
      pos: { row: 1093 },
    },
    lang: "es",
    dictionaryHits: [{ start: 3, end: 10, category: "pay", term: "salario" }],
    outputs: [
      {
        juror: "claude-haiku·9f2",
        label: "pay",
        confidence: 0.91,
        rationale:
          "“El salario nunca alcanzó” states compensation inadequacy directly; the affection for the team is valence, not theme.",
      },
    ],
    goldLabels: {},
    sourcePos: { doc: "techcorp-exit-survey.csv", row: 1093 },
  },
  u_55e0a9d4b7c2f311: {
    unit: {
      id: "u_55e0a9d4b7c2f311",
      text: "My director ⟨NAME_1⟩ promised a promotion for two cycles running. I believed ⟨NAME_1⟩ both times. That is on me.",
      meta: { dept: "Engineering" },
      pos: { row: 412 },
    },
    dictionaryHits: [{ start: 32, end: 41, category: "growth", term: "promotion" }],
    outputs: [
      {
        juror: "panel·maj",
        label: "growth",
        confidence: 0.72,
        rationale:
          "Stalled advancement (“promised a promotion … both times”) is the operative grievance.",
      },
    ],
    goldLabels: { pat: "growth" },
    sourcePos: { doc: "techcorp-exit-survey.csv", row: 412 },
    anonymized: true,
  },
  u_8800c1d2e4a90b77: {
    unit: {
      id: "u_8800c1d2e4a90b77",
      text: "Oh sure, the workload was totally reasonable. Eighty-hour weeks build character, right?",
      meta: { dept: "Support", satisfaction: 1 },
      pos: { row: 1881 },
    },
    dictionaryHits: [{ start: 13, end: 21, category: "workload", term: "workload" }],
    outputs: [
      { juror: "dictionary·work", label: "workload (0.04)", rationale: undefined },
      {
        juror: "claude-haiku·9f2",
        label: "workload-burnout",
        confidence: 0.66,
        rationale:
          "Sarcasm inverts the surface reading: “totally reasonable” + “eighty-hour weeks” signals burnout, not satisfaction.",
        escalated: true,
      },
    ],
    goldLabels: { sam: "workload-burnout" },
    sourcePos: { doc: "techcorp-exit-survey.csv", row: 1881 },
  },
};

const frame = $("inspector-frame");
const fakeApp = el("div", {
  class: "app",
  dataset: { inspector: "open" },
  style: { display: "block", height: "100%" },
});
frame.append(fakeApp);
const host = el("aside", {
  class: "app-inspector",
  style: { height: "100%", "border-left": "none" },
});
fakeApp.append(host);
inspector.init({ host, appRoot: fakeApp });
inspector.initEvidenceDelegation(
  (unitId) =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            FIXTURES[unitId] ?? {
              unit: {
                id: unitId,
                text: "(no fixture for this unit — in the app, the server assembles the dossier)",
              },
            },
          ),
        220,
      ),
    ),
);
inspector.open(DOSSIER);
// keep the framed panel visible even after Escape/close in the gallery
fakeApp.addEventListener("transitionend", () => fakeApp.setAttribute("data-inspector", "open"));
const reopen = new MutationObserver(() => {
  if (fakeApp.dataset.inspector !== "open") fakeApp.setAttribute("data-inspector", "open");
});
reopen.observe(fakeApp, { attributes: true, attributeFilter: ["data-inspector"] });

/* ---- toasts ---- */
toast.init();
$("toast-info").addEventListener("click", () =>
  toast.info("Corpus Brief is composing…", {
    detail: "stratified sample · 312 units",
    data: true,
  }),
);
$("toast-success").addEventListener("click", () =>
  toast.success("Instrument frozen at ●", {
    detail: "certificate written · κ = .82 vs gold",
    data: true,
  }),
);
$("toast-warn").addEventListener("click", () =>
  toast.warn("Label distribution is drifting.", {
    detail: "agreement on tripwire units fell 0.17 below certificate",
  }),
);
$("toast-error").addEventListener("click", () =>
  toast.error("Run paused: budget cap reached.", {
    detail: "$25.00 cap · resume after raising the cap",
    data: true,
  }),
);
