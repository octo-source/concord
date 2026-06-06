// Concord shell boot: theme, rail, router + ALL screens, inspector + evidence
// delegation, toasts, top-bar chips, the global drag-anywhere import overlay,
// and the Question Bar's compile-to-plan flow. Works with NO server and NO
// data — every zone shows its quiet empty state — and with ?fixtures=1 the
// whole product renders from app/fixtures/*.json (see js/fixtures.js).

import { bus } from "./bus.js";
import { store } from "./state.js";
import * as routerMod from "./router.js";
import api from "./api.js";
import { fmtCost, fmtCount } from "./format.js";
import { el, clear, frag } from "./dom.js";
import * as rail from "./components/rail.js";
import * as inspector from "./components/inspector.js";
import * as toast from "./components/toast.js";
import * as glyph from "./components/glyph.js";
import * as ladder from "./components/ladder.js";
import * as pipeline from "./components/pipeline.js";
import * as scopechip from "./components/scopechip.js";
import { fixturesEnabled, installFixtures } from "./fixtures.js";
import { openSheet, estimateChips, refreshProject } from "./screens/_shared.js";

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
import * as reliabilityScreen from "./screens/reliability.js";
import * as reportsScreen from "./screens/reports.js";
import * as settingsScreen from "./screens/settings.js";
import * as devScreens from "./screens/devscreens.js";

const $ = (id) => document.getElementById(id);

/* ---- screens registry --------------------------------------------------------- */

const SCREENS = [
  homeScreen, importScreen, instantreadScreen, briefScreen, explorerScreen,
  constructsScreen, instrumentsScreen, calibrationScreen, runsScreen,
  workbenchScreen, disagreementScreen, reliabilityScreen, reportsScreen,
  settingsScreen, devScreens,
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
      items: [
        ...(project.corpora ?? []).map((c) => item(c, { count: c.unitCount, href: `/p/${slug}/corpus/${c.id}/instant` })),
        // always-open door for the next file — a project is rarely one corpus
        { id: "corpora-import", label: "+ Import another file", humanTouched: true, href: `/p/${slug}/import` },
      ] },
    { id: "constructs", title: "Constructs", emptyHint: "What do you want to measure?",
      items: (project.constructs ?? []).map((c) => item(c, { href: `/p/${slug}/constructs/${c.id}` })) },
    { id: "instruments", title: "Instruments", emptyHint: "Compiled from constructs.",
      items: (project.instruments ?? []).map((i) => item(i, { href: `/p/${slug}/instruments/${i.id}` })) },
    { id: "goldsets", title: "Gold sets", emptyHint: "Hand-coded samples that instruments are checked against.",
      items: [
        ...(project.goldsets ?? []).map((g) => item(g, { count: g.n, href: `/p/${slug}/goldsets/${g.id}` })),
        // creatable from where you need it — needs a construct to code against
        ...((project.constructs ?? []).length
          ? [{ id: "goldsets-new", label: "+ New gold set…", humanTouched: true, action: "new-goldset" }]
          : []),
      ] },
    { id: "runs", title: "Runs", emptyHint: "Nothing has been measured yet.",
      items: (project.runs ?? []).map((r) => item({ id: r.id, name: r.id }, { href: `/p/${slug}/runs/${r.id}` })) },
    { id: "analyses", title: "Analyses", emptyHint: "Crosstabs, models, triangulation — corrected where gold exists.",
      items: [
        // the Workbench is the builder screen — findable before any analysis exists
        { id: "analyses-workbench", label: "Open the Workbench", humanTouched: true, href: `/p/${slug}/analyses` },
        ...(project.analyses ?? []).map((a) => item(a, { level: a.level, href: `/p/${slug}/analyses/${a.id}` })),
      ] },
    { id: "settings", title: "Project",
      items: [{ id: "settings", label: "Settings — Director, privacy, budget", humanTouched: true, href: `/p/${slug}/settings` }] },
  ];
}

function initRail() {
  const mount = $("rail-mount");
  if (!mount) return;
  railEl = rail.render({
    sections: projectToSections(store.get("project")),
    onSelect: (item) => {
      if (item.action === "new-goldset") newGoldsetSheet(store.get("project"));
    },
  });
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

/* The rail's "+ New gold set…" — pick a construct and a corpus, create, land
   in the Calibration Studio's Sample pane. Minimal: two selects, one button. */
function newGoldsetSheet(project) {
  const constructs = project?.constructs ?? [];
  const corpora = project?.corpora ?? [];
  if (!project?.slug || !constructs.length) {
    toast.info("Write a construct first.", { detail: "a gold set is hand-coding against one construct's codebook" });
    return;
  }
  if (!corpora.length) {
    toast.info("Import a corpus first.", { detail: "gold sets sample the units you will measure" });
    routerMod.navigate(`p/${project.slug}/import`);
    return;
  }

  const s = openSheet({ title: "New gold set", overline: "Human gold standard" });
  let constructId = constructs[0].id;
  let corpusId = corpora.at(-1)?.id ?? null; // most recently created — same default as runs/previews

  const constructSel = el("select", { class: "input", "aria-label": "Construct to code by hand" },
    ...constructs.map((c) => el("option", { value: c.id, selected: c.id === constructId }, c.name)));
  constructSel.addEventListener("change", () => { constructId = constructSel.value; });
  const corpusSel = el("select", { class: "input", "aria-label": "Corpus to sample — picking a corpus picks the text column" },
    ...corpora.map((c) => el("option", { value: c.id, selected: c.id === corpusId }, scopechip.optionLabel(c, project))));
  corpusSel.addEventListener("change", () => { corpusId = corpusSel.value; });

  s.body.append(
    el("p", {}, "A gold set is a sample you code by hand — the human standard that agreement statistics certify instruments against."),
    el("label", { class: "field" }, el("span", { class: "field__label overline" }, "Construct"), constructSel),
    el("label", { class: "field" }, el("span", { class: "field__label overline" }, "Corpus to sample"), corpusSel),
  );
  const createBtn = el("button", {
    class: "btn btn--primary", type: "button",
    onclick: async (e) => {
      e.target.disabled = true;
      try {
        const created = await api.goldsets.create(project.slug, { constructId, corpusId });
        toast.success("Gold set created.", { detail: "draw the sample, then code it blind", data: false });
        await refreshProject(project.slug).catch(() => {});
        s.close();
        routerMod.navigate(`p/${project.slug}/goldsets/${created.id}`);
      } catch (err) {
        e.target.disabled = false;
        toast.error("Could not create the gold set.", { detail: String(err.message ?? err) });
      }
    },
  }, "Create the gold set");
  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    createBtn,
  );
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

  // frag() skips null children; NATIVE append would print them as "null"
  s.body.append(frag(
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
  ));

  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Dismiss"),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const approved = await api.questionbar.approve(project.slug, planId);
          toast.success("Plan approved — constructs and instruments created.", {
            detail: `${(approved?.constructIds ?? []).length} constructs · ${(approved?.instrumentIds ?? []).length} instruments`,
            data: true,
          });
          // the rail must show the new artifacts before the sheet points at them
          const fresh = await refreshProject(project.slug).catch(() => null);
          deliveryView(s, fresh ?? project, plan, approved);
        } catch (err) {
          e.target.disabled = false;
          toast.error("Approval failed.", { detail: String(err.message ?? err) });
        }
      },
    }, "Approve the plan"),
  );
}

/* The post-approve delivery view — the same sheet, repainted in place. The
   plan's pieces are now real artifacts; this lists each one with a link to
   where it lives, shows the pipeline position (construct and instrument done,
   run next), and offers the preflight as the primary next step. */
function deliveryView(s, project, plan, approved) {
  const slug = project.slug;
  const constructIds = approved?.constructIds ?? [];
  const instrumentIds = approved?.instrumentIds ?? [];
  const runIds = approved?.runIds ?? [];
  const total = constructIds.length + instrumentIds.length + runIds.length;

  // resolve real names from the refreshed graph; fall back to the plan's specs
  const constructName = (id, i) =>
    (project.constructs ?? []).find((c) => c.id === id)?.name ?? plan.constructs?.[i]?.name ?? id;
  const instrumentName = (id, i) => {
    const inst = (project.instruments ?? []).find((x) => x.id === id);
    if (inst?.name) return inst.name;
    const spec = plan.instruments?.[i];
    return spec?.constructName ? `${spec.constructName} — judge` : id;
  };

  // repaint the header: this is no longer a proposal
  const titleEl = s.el.querySelector(".sheet__title");
  if (titleEl) titleEl.textContent = "What was created";
  const overEl = s.el.querySelector(".sheet__head .overline");
  if (overEl) overEl.textContent = "Plan approved";

  const followLink = () => s.close(); // the sheet must not cover the artifact it points at
  const items = [
    ...constructIds.map((id, i) =>
      el("li", { class: "plansheet__item" },
        el("span", { class: "chip" }, "construct"),
        el("a", { class: "plansheet__name", href: `#/p/${slug}/constructs/${id}`, onclick: followLink }, constructName(id, i)),
        el("span", { class: "faint" }, "→ opens in the codebook"))),
    ...instrumentIds.map((id, i) =>
      el("li", { class: "plansheet__item" },
        el("span", { class: "chip" }, "instrument"),
        el("a", { class: "plansheet__name", href: `#/p/${slug}/instruments/${id}`, onclick: followLink },
          instrumentName(id, i),
          glyph.render({ authoredBy: "director", humanTouched: false })),
        ladder.render({ level: "exploratory", size: "sm" }),
        el("span", { class: "faint" }, "→ opens in its editor"))),
    ...runIds.map((id) =>
      el("li", { class: "plansheet__item" },
        el("span", { class: "chip" }, "run"),
        el("a", { class: "plansheet__name data", href: `#/p/${slug}/runs/${id}`, onclick: followLink }, id),
        el("span", { class: "faint" }, "— created, not started; you control when it reads the corpus and what it costs"))),
  ];

  clear(s.body).append(frag(
    el("p", { class: "plansheet__q" },
      `The plan is now ${fmtCount(total)} artifact${total === 1 ? "" : "s"} you can inspect and edit:`),
    el("ul", { class: "plansheet__list", role: "list" }, ...items),
    pipeline.render({ current: "run", states: { run: "next" } }),
  ));

  const firstInstrument = instrumentIds[0];
  clear(s.foot).append(frag(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Done"),
    firstInstrument
      ? el("button", {
          class: "btn btn--primary", type: "button",
          onclick: () => {
            s.close();
            routerMod.navigate(`p/${slug}/runs?preflight=${firstInstrument}`);
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          },
        }, "Preflight the first run →")
      : null,
  ));
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
