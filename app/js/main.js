// Concord shell boot: theme, rail, router, inspector + evidence delegation,
// toasts, top-bar chips, keyboard map. Works with NO server and NO data —
// every zone shows its quiet empty state, and the rail footer says plainly
// whether a server is listening.

import { bus } from "./bus.js";
import { store } from "./state.js";
import * as routerMod from "./router.js";
import api from "./api.js";
import { fmtCost } from "./format.js";
import * as rail from "./components/rail.js";
import * as inspector from "./components/inspector.js";
import * as toast from "./components/toast.js";

const $ = (id) => document.getElementById(id);

/* ---- theme ----------------------------------------------------------------- */

function appliedTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function setTheme(theme) {
  // theme: "light" | "dark" — applied; "auto" cleared via storage removal
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
      items: (project.corpora ?? []).map((c) => item(c, { count: c.unitCount, href: `/corpora/${c.id}` })) },
    { id: "constructs", title: "Constructs", emptyHint: "What do you want to measure?",
      items: (project.constructs ?? []).map((c) => item(c, { href: `/constructs/${c.id}` })) },
    { id: "instruments", title: "Instruments", emptyHint: "Compiled from constructs.",
      items: (project.instruments ?? []).map((i) => item(i, { href: `/instruments/${i.id}` })) },
    { id: "runs", title: "Runs", emptyHint: "Nothing has been measured yet.",
      items: (project.runs ?? []).map((r) => item({ id: r.id, name: r.id }, { href: `/runs/${r.id}` })) },
    { id: "analyses", title: "Analyses", emptyHint: "Ask the data a question.",
      items: (project.analyses ?? []).map((a) => item(a, { level: a.level, href: `/analyses/${a.id}` })) },
  ];
}

function initRail() {
  const mount = $("rail-mount");
  if (!mount) return;
  railEl = rail.render({ sections: projectToSections(store.get("project")) });
  mount.append(railEl);
  store.subscribe("project", (project) => {
    railEl.update({ sections: projectToSections(project) });
  });
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

/* ---- question bar (element only; behavior lands with screens) -------------------- */

function initQuestionBar() {
  const input = $("questionbar");
  if (!input) return;
  // "/" focuses the bar from anywhere outside a field
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
  // until screens wire compilation, Enter explains itself quietly
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    toast.info("The Question Bar compiles once a project is open.", {
      detail: "Your question becomes constructs, instruments, and a plan you approve.",
    });
  });
}

/* ---- inspector -------------------------------------------------------------------- */

function initInspector() {
  const host = $("inspector");
  const app = $("app");
  inspector.init({ host, appRoot: app });

  inspector.initEvidenceDelegation(async (unitId) => {
    const project = store.get("project");
    if (!project?.slug) {
      // no project open — show what we know locally (gallery/dev usage)
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

function boot() {
  initTheme();
  toast.init();
  initRail();
  initChips();
  initQuestionBar();
  initInspector();

  routerMod.start({ root: $("workspace") });

  // chips reflect any project that screens load later
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

// surfaced for screens (H2) and the console
window.concord = { api, store, bus, router: routerMod, inspector, toast };
