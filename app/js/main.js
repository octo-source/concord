// Concord shell boot: theme, rail, router + ALL screens, inspector + evidence
// delegation, toasts, top-bar chips, the global drag-anywhere import overlay,
// and the Question Bar's compile-to-plan flow. Works with NO server and NO
// data — every zone shows its quiet empty state — and with ?fixtures=1 the
// whole product renders from app/fixtures/*.json (see js/fixtures.js).

import { bus } from "./bus.js";
import { store } from "./state.js";
import * as routerMod from "./router.js";
import api from "./api.js";
import { fmtCost } from "./format.js";
import { el } from "./dom.js";
import * as rail from "./components/rail.js";
import * as inspector from "./components/inspector.js";
import * as toast from "./components/toast.js";
import * as glyph from "./components/glyph.js";
import { fixturesEnabled, installFixtures } from "./fixtures.js";
import { openSheet, estimateChips } from "./screens/_shared.js";

// the twelve (plus home and the dev index)
import * as homeScreen from "./screens/home.js";
import * as importScreen from "./screens/import.js";
import * as instantreadScreen from "./screens/instantread.js";
import * as briefScreen from "./screens/brief.js";
import * as explorerScreen from "./screens/explorer.js";
import * as constructsScreen from "./screens/constructs.js";
import * as instrumentsScreen from "./screens/instruments.js";
import * as calibrationScreen from "./screens/calibration.js";
import * as runsScreen from "./screens/runs.js";
import * as workbenchScreen from "./screens/workbench.js";
import * as disagreementScreen from "./screens/disagreement.js";
import * as reportsScreen from "./screens/reports.js";
import * as settingsScreen from "./screens/settings.js";
import * as devScreens from "./screens/devscreens.js";

const $ = (id) => document.getElementById(id);

/* ---- screens registry --------------------------------------------------------- */

const SCREENS = [
  homeScreen, importScreen, instantreadScreen, briefScreen, explorerScreen,
  constructsScreen, instrumentsScreen, calibrationScreen, runsScreen,
  workbenchScreen, disagreementScreen, reportsScreen, settingsScreen, devScreens,
];

function registerScreens() {
  for (const screen of SCREENS) {
    const patterns = screen.routes ?? [screen.route];
    for (const pattern of patterns) {
      routerMod.register(pattern, (mount, params, query) => screen.render(mount, params, query));
    }
  }
  // project landing redirect lives with home
  routerMod.register("p/:slug", (mount, params) => homeScreen.renderProject(mount, params));

  // document titles follow the screen
  bus.on("route:changed", ({ path }) => {
    const match = SCREENS.find((s) => {
      const pats = s.routes ?? [s.route];
      return pats.some((p) => patternMatches(p, path));
    });
    document.title = match ? `${match.title} — Concord` : "Concord";
  });
}

function patternMatches(pattern, path) {
  const a = pattern === "" ? [] : pattern.split("/");
  const b = path === "" ? [] : path.split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
}

/* ---- theme ----------------------------------------------------------------- */

function appliedTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function setTheme(theme) {
  if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
  try { localStorage.setItem("concord-theme", theme); } catch { /* private mode */ }
  store.set("ui.theme", theme);
  bus.emit("theme:changed", theme);
}

function initTheme() {
  const btn = $("theme-toggle");
  btn?.addEventListener("click", () => {
    const next = appliedTheme() === "dark" ? "light" : "dark";
    setTheme(next);
    btn.setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} theme`);
  });
}

/* ---- rail ------------------------------------------------------------------- */

let railEl = null;

function projectToSections(project) {
  if (!project) return rail.DEFAULT_SECTIONS;
  const slug = project.slug;
  const item = (o, extra = {}) => ({
    id: o.id,
    label: o.name ?? o.id,
    level: o.level,
    authoredBy: o.authoredBy,
    humanTouched: o.humanTouched ?? true,
    ...extra,
  });
  return [
    { id: "corpora", title: "Corpora", emptyHint: "Drop a file anywhere to begin.",
      items: (project.corpora ?? []).map((c) => item(c, { count: c.unitCount, href: `/p/${slug}/corpus/${c.id}/instant` })) },
    { id: "constructs", title: "Constructs", emptyHint: "What do you want to measure?",
      items: (project.constructs ?? []).map((c) => item(c, { href: `/p/${slug}/constructs/${c.id}` })) },
    { id: "instruments", title: "Instruments", emptyHint: "Compiled from constructs.",
      items: (project.instruments ?? []).map((i) => item(i, { href: `/p/${slug}/instruments/${i.id}` })) },
    { id: "goldsets", title: "Gold sets", emptyHint: "Human judgment, sampled with π.",
      items: (project.goldsets ?? []).map((g) => item(g, { count: g.n, href: `/p/${slug}/goldsets/${g.id}` })) },
    { id: "runs", title: "Runs", emptyHint: "Nothing has been measured yet.",
      items: (project.runs ?? []).map((r) => item({ id: r.id, name: r.id }, { href: `/p/${slug}/runs/${r.id}` })) },
    { id: "analyses", title: "Analyses", emptyHint: "Ask the data a question.",
      items: (project.analyses ?? []).map((a) => item(a, { level: a.level, href: `/p/${slug}/analyses/${a.id}` })) },
  ];
}

function initRail() {
  const mount = $("rail-mount");
  if (!mount) return;
  railEl = rail.render({ sections: projectToSections(store.get("project")) });
  mount.append(railEl);
  store.subscribe("project", (project) => {
    railEl.update({ sections: projectToSections(project), activeId: activeRailId() });
  });
  bus.on("route:changed", () => {
    railEl.update({ sections: projectToSections(store.get("project")), activeId: activeRailId() });
  });
}

function activeRailId() {
  const r = routerMod.current();
  return r?.params?.id ?? r?.params?.cid ?? r?.params?.gid ?? r?.params?.runId ?? r?.params?.rid ?? null;
}

/* ---- top-bar chips ------------------------------------------------------------ */

const PRIVACY_LABEL = { open: "open", "no-training": "no-training", strict: "strict · local only" };

function initChips() {
  store.subscribe("ui.costUSD", (usd) => {
    const chip = $("cost-chip");
    if (chip) chip.textContent = fmtCost(usd ?? 0);
  });
  store.subscribe("ui.privacyMode", (mode) => {
    const chip = $("privacy-chip");
    if (!chip) return;
    if (!mode) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.textContent = PRIVACY_LABEL[mode] ?? mode;
    chip.classList.toggle("topbar__chip--strict", mode === "strict");
  });
  // budget spend follows the open project
  store.subscribe("project", (project) => {
    if (project?.budget) store.set("ui.costUSD", project.budget.spentUSD ?? 0);
  });
}

/* ---- server health -------------------------------------------------------------- */

async function pingServer() {
  const dot = $("server-dot");
  const railDot = $("rail-status-dot");
  const railText = $("rail-status");
  try {
    const h = await api.health();
    store.set("ui.serverOk", true);
    dot?.classList.add("status-dot--ok");
    dot?.classList.remove("status-dot--down");
    dot?.setAttribute("aria-label", "Server status: connected");
    railDot?.classList.add("status-dot--ok");
    if (railText) railText.textContent = `concord ${h?.version ?? ""}`.trim();
  } catch {
    store.set("ui.serverOk", false);
    dot?.classList.add("status-dot--down");
    dot?.setAttribute("aria-label", "Server status: unreachable");
    railDot?.classList.add("status-dot--down");
    if (railText) railText.textContent = "no server — static preview";
  }
}

/* ---- global drag-anywhere import -------------------------------------------------- */

function initGlobalDrop() {
  let overlay = null;
  let depth = 0;

  const showOverlay = () => {
    if (overlay) return;
    const project = store.get("project");
    overlay = el("div", { class: "dropveil", role: "status" },
      el("div", { class: "dropveil__card" },
        el("p", { class: "dropveil__mark", aria: { hidden: "true" } }, "⇣"),
        el("p", { class: "dropveil__line" },
          project ? `Drop to import into “${project.name}”` : "Drop to import — a project sheet will follow"),
        el("p", { class: "dropveil__hint faint" }, "CSV · XLSX · DOCX · PDF · TXT · VTT/SRT")));
    document.body.append(overlay);
    requestAnimationFrame(() => overlay?.classList.add("dropveil--in"));
  };
  const hideOverlay = () => {
    overlay?.remove();
    overlay = null;
    depth = 0;
  };

  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes?.("Files")) return;
    depth += 1;
    showOverlay();
  });
  document.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes?.("Files")) return;
    e.preventDefault(); // required to allow drop
  });
  document.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) hideOverlay();
  });
  document.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) { hideOverlay(); return; }
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    hideOverlay();
    const project = store.get("project");
    store.set("ui.pendingImport", file);
    if (project?.slug) {
      routerMod.navigate(`p/${project.slug}/import`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      toast.info(`“${file.name}” is ready to import.`, { detail: "open or create a project — the file follows you to its Import screen" });
      routerMod.navigate("");
    }
  });
}

/* ---- the Question Bar — chat as compiler, never oracle ------------------------------ */

function initQuestionBar() {
  const input = $("questionbar");
  if (!input) return;

  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing) return;
    e.preventDefault();
    input.focus();
    input.select();
  });

  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    const question = input.value.trim();
    const project = store.get("project");
    if (!project?.slug) {
      toast.info("Open a project first.", { detail: "the Question Bar compiles your question against a corpus" });
      return;
    }
    input.disabled = true;
    input.classList.add("qbar__input--thinking");
    try {
      const res = await api.questionbar.ask(project.slug, question);
      planSheet(project, res, question);
    } catch (err) {
      toast.error("The question did not compile.", { detail: String(err.message ?? err) });
    }
    input.disabled = false;
    input.classList.remove("qbar__input--thinking");
  });
}

// Live plan instruments carry {constructId, constructName, workerClass,
// provider, model} — no name/kind. Render the construct's name with
// workerClass/model chips (old name/kind shapes still tolerated).
function planInstrumentRow(i) {
  return el("li", { class: "plansheet__item" },
    el("span", { class: "plansheet__name" }, i.constructName ?? i.name ?? i.model ?? "instrument"),
    i.workerClass ? el("span", { class: "chip chip--ghost" }, i.workerClass) : null,
    i.kind ? el("span", { class: "chip" }, i.kind) : null,
    i.model ? el("span", { class: "chip", title: i.provider ? `${i.provider}/${i.model}` : i.model }, i.model) : null);
}

// One readable line out of an analysis spec object ("pay × dept", "by dept",
// "label ~ satisfaction + tenure") — never "[object Object]".
function planSpecLine(spec) {
  if (spec === null || spec === undefined) return "";
  if (typeof spec === "string") return spec;
  if (typeof spec !== "object") return String(spec);
  if (spec.rowKey && spec.colKey) return `${spec.rowKey} × ${spec.colKey}`;
  if (spec.by) return `by ${spec.by}`;
  if (Array.isArray(spec.x) && spec.x.length) return `${spec.positive ?? "label"} ~ ${spec.x.join(" + ")}`;
  if (Array.isArray(spec.instrumentIds)) return spec.instrumentIds.join(" vs ");
  const parts = Object.entries(spec)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${v}`);
  return parts.join(" · ");
}

function planSheet(project, res, question) {
  const plan = res?.plan ?? {};
  const planId = res?.planId;
  const s = openSheet({ title: "The plan, before the spend", overline: "Question → artifacts", wide: true });

  const analysis = plan.analysis ?? {};
  const specLine = planSpecLine(analysis.spec);

  s.body.append(
    el("p", { class: "plansheet__q" }, "“", plan.question ?? res?.question ?? question, "”"),
    plan.summary ? el("p", { class: "plansheet__summary" }, plan.summary) : null,

    el("h3", { class: "overline screen__section-label" }, "Constructs it will draft"),
    el("ul", { class: "plansheet__list", role: "list" },
      ...(plan.constructs ?? []).map((c) =>
        el("li", { class: "plansheet__item" },
          el("span", { class: "plansheet__name" }, c.name, glyph.render({ authoredBy: "director", humanTouched: false })),
          el("span", { class: "chip" }, c.type),
          el("span", { class: "plansheet__def faint" }, c.definition)))),

    el("h3", { class: "overline screen__section-label" }, "Instruments it will compile"),
    el("ul", { class: "plansheet__list", role: "list" },
      ...(plan.instruments ?? []).map((i) => planInstrumentRow(i))),

    el("h3", { class: "overline screen__section-label" }, "What it will cost"),
    el("p", { class: "plansheet__est" },
      estimateChips(plan.estimate ?? {}),
      plan.estimate?.note ? el("span", { class: "faint" }, " ", plan.estimate.note) : null),

    el("h3", { class: "overline screen__section-label" }, "The analysis it produces"),
    el("p", { class: "plansheet__analysis" },
      el("span", { class: "chip" }, analysis.kind ?? "analysis"),
      specLine ? el("span", { class: "data" }, " ", specLine, " ") : " ",
      (analysis.annotation ?? analysis.note)
        ? el("span", { class: "faint" }, analysis.annotation ?? analysis.note)
        : null),
  );

  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Dismiss"),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const approved = await api.questionbar.approve(project.slug, planId);
          s.close();
          toast.success("Plan approved — artifacts materialized.", {
            detail: `${(approved?.constructIds ?? []).length} constructs · ${(approved?.instrumentIds ?? []).length} instruments`,
            data: true,
          });
          const firstInstrument = approved?.instrumentIds?.[0];
          routerMod.navigate(`p/${project.slug}/runs${firstInstrument ? `?preflight=${firstInstrument}` : ""}`);
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        } catch (err) {
          e.target.disabled = false;
          toast.error("Approval failed.", { detail: String(err.message ?? err) });
        }
      },
    }, "Approve the plan"),
  );
}

/* ---- inspector -------------------------------------------------------------------- */

function initInspector() {
  const host = $("inspector");
  const app = $("app");
  inspector.init({ host, appRoot: app });

  inspector.initEvidenceDelegation(async (unitId) => {
    const project = store.get("project");
    if (!project?.slug) {
      return { unit: { id: unitId, text: "(open a project to assemble this unit's dossier)" } };
    }
    return api.evidence.get(project.slug, unitId);
  });

  $("inspector-toggle")?.addEventListener("click", () => {
    if (inspector.isOpen()) inspector.close();
    else inspector.open({ unit: { id: "—", text: "Click any number, bar, or cell that carries the evidence mark to read its dossier here." } }, { title: "Evidence" });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inspector.isOpen()) inspector.close();
  });
}

/* ---- boot --------------------------------------------------------------------------- */

async function boot() {
  initTheme();
  toast.init();

  if (fixturesEnabled()) {
    try {
      await installFixtures();
      console.info("concord: fixtures mode — api resolves from app/fixtures/*.json");
    } catch (err) {
      console.error("fixtures failed to install", err);
      toast.error("Fixtures failed to load.", { detail: String(err.message ?? err) });
    }
  }

  initRail();
  initChips();
  initQuestionBar();
  initInspector();
  initGlobalDrop();
  registerScreens();

  routerMod.start({ root: $("workspace") });

  store.subscribe("project", (project) => {
    store.set("ui.privacyMode", project?.privacyMode ?? null);
  });

  pingServer();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// surfaced for screens and the console
window.concord = { api, store, bus, router: routerMod, inspector, toast };
