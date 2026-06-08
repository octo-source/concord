// Shared furniture for the screens wave: headers, sections, sheets, estimate
// chips, a safe mini-markdown renderer, async screen scaffolding, and the
// project loader that keeps the rail in step. Screens compose H1 components;
// this module only adds the connective tissue they share.

import { el, clear, frag } from "../dom.js";
import { store } from "../state.js";
import { bus } from "../bus.js";
import * as router from "../router.js";
import api from "../api.js";
import * as ladder from "../components/ladder.js";
import * as glyph from "../components/glyph.js";
import * as scopechip from "../components/scopechip.js";
import { fmtCost, fmtCount, fmtDuration } from "../format.js";

/* ---- screen scaffolding ----------------------------------------------------- */

/**
 * screenHead({ overline, title, glyphState, lede, actions, marks }) → <header>
 * The quiet top of every screen: section voice, Fraunces title, optional
 * Director glyph, lede, action cluster on the right.
 */
export function screenHead({ overline, title, lede, actions = [], glyphState = null, titleSuffix = null } = {}) {
  return el("header", { class: "screen__head" },
    el("div", { class: "screen__head-text" },
      overline ? el("p", { class: "overline" }, overline) : null,
      el("h2", { class: "screen__title" },
        title,
        glyphState ? glyph.render(glyphState) : null,
        titleSuffix,
      ),
      lede ? el("p", { class: "screen__lede" }, lede) : null,
    ),
    actions.length ? el("div", { class: "screen__actions" }, ...actions) : null,
  );
}

export function section(title, ...children) {
  return el("section", { class: "screen__section" },
    title ? el("h3", { class: "overline screen__section-label" }, title) : null,
    ...children,
  );
}

export function emptyState({ mark = "◌", title, body, hint, actions = [] } = {}) {
  return el("div", { class: "empty-state" },
    el("p", { class: "empty-state__mark", aria: { hidden: "true" } }, mark),
    el("h2", { class: "empty-state__title" }, title),
    body ? el("p", { class: "empty-state__body" }, body) : null,
    hint ? el("p", { class: "empty-state__hint" }, hint) : null,
    actions.length ? el("p", { class: "empty-state__actions" }, ...actions) : null,
  );
}

export function loadingView(line = "Composing…") {
  return el("div", { class: "screen-loading", role: "status" },
    el("span", { class: "screen-loading__rule", aria: { hidden: "true" } }),
    el("p", { class: "screen-loading__line" }, line),
  );
}

export function errorView(err, { retry } = {}) {
  const isUnreachable = err?.code === "UNREACHABLE";
  return el("div", { class: "empty-state" },
    el("p", { class: "empty-state__mark empty-state__mark--signal", aria: { hidden: "true" } }, "◌"),
    el("h2", { class: "empty-state__title" }, isUnreachable ? "The server is not answering." : "This page failed to compose."),
    el("p", { class: "empty-state__body" }, String(err?.message ?? err)),
    isUnreachable
      ? el("p", { class: "empty-state__hint" }, "Start Concord with start.bat — or review the screens with fixtures: ",
          el("a", { href: "#/dev/screens?fixtures=1" }, "open fixtures mode"), ".")
      : null,
    retry ? el("p", { class: "empty-state__actions" }, el("button", { class: "btn", type: "button", onclick: retry }, "Try again")) : null,
  );
}

/**
 * asyncMount(mount, loader, renderFn, loadingLine) — standard screen rhythm:
 * loading rule → data → compose; errors land as the designed error state.
 *
 * mount is the persistent #workspace node, so a route change DURING loader()
 * must not let the late paint clobber the screen that replaced this one. We
 * capture the router's current route-state object on entry (the router mints a
 * fresh one on every resolve, same path or not) and bail before clear/renderFn
 * — and before the error state — once it no longer matches. The router already
 * cleared #workspace for the new screen; painting here would cover it.
 */
export async function asyncMount(mount, loader, renderFn, loadingLine) {
  const token = router.current();
  const stale = () => router.current() !== token;
  clear(mount).append(loadingView(loadingLine));
  try {
    const data = await loader();
    if (stale()) return;
    clear(mount);
    await renderFn(data);
  } catch (err) {
    if (stale()) return;
    console.error(err);
    clear(mount).append(errorView(err, { retry: () => asyncMount(mount, loader, renderFn, loadingLine) }));
  }
}

/* ---- project loading ---------------------------------------------------------- */

let loadedSlug = null;

/** Load the project graph into the store (rail + chips follow). Cached per slug. */
export async function ensureProject(slug) {
  const current = store.get("project");
  if (current?.slug === slug && loadedSlug === slug) return current;
  const project = await api.projects.get(slug);
  loadedSlug = slug;
  store.set("project", project);
  return project;
}

/** Re-fetch the graph after a mutation so the rail stays honest. */
export async function refreshProject(slug) {
  loadedSlug = null;
  return ensureProject(slug);
}

/* ---- sheets — the sliding work surface ------------------------------------------ */

/**
 * sheet({ title, overline, wide, onClose }) → { el, body, foot, close, setLocked }
 * A paper sheet that slides up over a scrim. Escape and the scrim close it;
 * focus moves in on open and returns to the opener on close.
 *
 * setLocked(true) — for the duration of a paid in-flight call: Escape and the
 * scrim STOP closing the sheet (a stray click must not read as a cancel), and
 * the × relabels to "Hide (keeps running)". × always works: hiding is allowed,
 * accidental dismissal is not. setLocked(false) restores normal closing.
 */
export function openSheet({ title, overline, wide = false, onClose } = {}) {
  const opener = document.activeElement;
  const body = el("div", { class: "sheet__body" });
  const foot = el("div", { class: "sheet__foot" });
  let locked = false;

  const closeBtn = el("button", {
    class: "sheet__close", type: "button", title: "Close",
    aria: { label: "Close" }, onclick: () => close(),
  }, "×");

  const panel = el("div", {
    class: `sheet__panel${wide ? " sheet__panel--wide" : ""}`,
    role: "dialog",
    "aria-modal": "true",
    aria: { label: title ?? "Sheet" },
  },
    el("header", { class: "sheet__head" },
      el("div", {},
        overline ? el("p", { class: "overline" }, overline) : null,
        el("h2", { class: "sheet__title" }, title ?? ""),
      ),
      closeBtn,
    ),
    body,
    foot,
  );

  const root = el("div", { class: "sheet" },
    el("div", { class: "sheet__scrim", onclick: () => { if (!locked) close(); } }),
    panel,
  );

  function setLocked(on) {
    locked = Boolean(on);
    const label = locked ? "Hide (keeps running)" : "Close";
    closeBtn.setAttribute("aria-label", label);
    closeBtn.title = label;
    root.classList.toggle("sheet--locked", locked);
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!locked) close();
    } else if (e.key === "Tab") {
      // soft focus trap — wrap within the panel
      const focusables = panel.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    offRoute();
    root.classList.add("sheet--leaving");
    root.removeEventListener("keydown", onKey);
    const remove = () => {
      root.remove();
      onClose?.();
      if (opener?.isConnected && typeof opener.focus === "function") opener.focus();
    };
    panel.addEventListener("transitionend", remove, { once: true });
    setTimeout(remove, 350);
  }

  // The router only clears #workspace; a sheet mounts on document.body and
  // would otherwise survive navigation (its focus trap covering the next
  // screen). Close on route change — even a locked, in-flight sheet, since the
  // screen it belonged to is gone — and drop the subscription in close().
  const offRoute = bus.on("route:changed", () => close());

  root.addEventListener("keydown", onKey);
  document.body.append(root);
  // compose in after first style resolution (timeout, not rAF — hidden tabs)
  setTimeout(() => root.classList.add("sheet--in"), 20);
  setTimeout(() => panel.querySelector("input, select, textarea, button:not(.sheet__close)")?.focus(), 240);

  return { el: root, body, foot, close, setLocked };
}

/**
 * buttonBusy(btn, label) → stop()
 * A running action says so ON the button: disabled, aria-busy, and the
 * present-tense label with a live elapsed timer ("Compiling · 14s"). stop()
 * restores the idle label and re-enables. label(seconds) → string.
 */
export function buttonBusy(btn, label) {
  const idleLabel = btn.textContent;
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = label(0);
  const started = Date.now();
  const timer = setInterval(() => {
    btn.textContent = label(Math.round((Date.now() - started) / 1000));
  }, 1000);
  return () => {
    clearInterval(timer);
    btn.removeAttribute("aria-busy");
    btn.textContent = idleLabel;
    btn.disabled = false;
  };
}

/**
 * sheetBusy(s, actionBtn, { label, hint }) → stop()
 * The in-flight state of a sheet's one paid action. The BUTTON carries the
 * present-tense label with the live elapsed timer ("Running the inductive
 * pass · 14s"), disabled and aria-busy; the foot keeps a sweeping rule with
 * the static context line (`hint`); the sheet locks — Escape and the scrim
 * no longer close it, and × relabels to "Hide (keeps running)". stop()
 * restores the idle label, re-enables the button, and unlocks the sheet.
 */
export function sheetBusy(s, actionBtn, { label, hint } = {}) {
  const stopBtn = buttonBusy(actionBtn, label);
  const line = el("span", { class: "busyline", role: "status" },
    el("span", { class: "busyline__rule", aria: { hidden: "true" } }),
    hint ? el("span", { class: "busyline__text" }, hint) : null);
  s.foot.replaceChildren(line, actionBtn);
  s.setLocked?.(true);
  return () => {
    stopBtn();
    s.setLocked?.(false);
  };
}

/* ---- display names ------------------------------------------------------------------
   Runs and gold sets carry a `name` (auto-named at creation: "<instrument> ·
   <corpus>" / "Gold — <construct>"). Legacy records predate names — these
   helpers derive the SAME shape client-side so every list, rail item, and
   picker reads alike whichever era the record is from. */

/** run.name || "<instrument> · <corpus>" derived from the project graph. */
export function runDisplayName(project, run) {
  if (!run) return "";
  if (run.name) return run.name;
  const inst = (project?.instruments ?? []).find((i) => i.id === run.instrumentId) ?? null;
  const corpus = (project?.corpora ?? []).find((c) => c.id === run.corpusId) ?? null;
  const instName = inst?.name ?? run.instrumentId ?? null;
  const corpusName = corpus ? scopechip.displayName(corpus) : run.corpusId ?? null;
  if (instName && corpusName) return `${instName} · ${corpusName}`;
  return instName ?? corpusName ?? run.id ?? "";
}

/** goldset.name || "Gold — <construct>" derived from the project graph. */
export function goldsetDisplayName(project, goldset) {
  if (!goldset) return "";
  if (goldset.name) return goldset.name;
  const construct = (project?.constructs ?? []).find((c) => c.id === goldset.constructId) ?? null;
  return construct ? `Gold — ${construct.name}` : goldset.id ?? "";
}

/** Truncate for tight slots (the rail); pair with title= carrying the full text. */
export function truncate(text, max = 34) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/* ---- quarantine -------------------------------------------------------------------- */

/**
 * Normalize quarantine entries from runs and previews. Current servers record
 * WHY a unit failed — {unitId, code, message} — while older artifacts carry
 * bare unit-id strings. Both normalize to the object shape; legacy entries
 * come back with null code/message, so counts render and nothing invents a
 * reason that was never recorded.
 */
export function normalizeQuarantine(quarantine) {
  return (Array.isArray(quarantine) ? quarantine : [])
    .filter((q) => q !== null && q !== undefined)
    .map((q) => (typeof q === "object"
      ? { unitId: q.unitId ?? null, code: q.code ?? null, message: q.message ?? null }
      : { unitId: String(q), code: null, message: null }));
}

/* ---- chips & lines ----------------------------------------------------------------- */

/** Estimate chips: units · calls · $ · eta. Every screen quotes prices the same way. */
export function estimateChips({ units, calls, usd, usdRange, etaMin } = {}) {
  const chips = [];
  if (units !== undefined && units !== null) chips.push(el("span", { class: "chip data" }, `${fmtCount(units)} units`));
  if (calls !== undefined && calls !== null && calls !== units) chips.push(el("span", { class: "chip data" }, `${fmtCount(calls)} calls`));
  if (usdRange) chips.push(el("span", { class: "chip data" }, `${fmtCost(usdRange[0])}–${fmtCost(usdRange[1])}`));
  else if (usd !== undefined && usd !== null) chips.push(el("span", { class: "chip data" }, fmtCost(usd)));
  if (etaMin !== undefined && etaMin !== null) chips.push(el("span", { class: "chip data" }, fmtDuration(etaMin)));
  return el("span", { class: "estchips" }, ...chips);
}

/** A labeled value row for definition lists. */
export function kv(label, ...value) {
  return el("div", { class: "kv" },
    el("dt", { class: "kv__label overline" }, label),
    el("dd", { class: "kv__value" }, ...value),
  );
}

export function kvList(...rows) {
  return el("dl", { class: "kvlist" }, ...rows);
}

/** A value with its ladder mark — the canonical way a number appears. */
export function markedValue(text, level, { size = "sm" } = {}) {
  return el("span", { class: "markedvalue" },
    el("span", { class: "data" }, text),
    level ? ladder.render({ level, size }) : null,
  );
}

/** Director-flagged margin annotation, dismissible. */
export function annotation({ text, by = "director", onDismiss } = {}) {
  const node = el("aside", { class: "annotation" },
    by === "director" ? el("span", { class: "annotation__glyph", aria: { hidden: "true" } }, glyph.GLYPH) : null,
    el("p", { class: "annotation__text" }, text),
    onDismiss !== false
      ? el("button", {
          class: "annotation__dismiss", type: "button", aria: { label: "Dismiss annotation" },
          onclick: () => { node.classList.add("annotation--leaving"); setTimeout(() => { node.remove(); onDismiss?.(); }, 200); },
        }, "×")
      : null,
  );
  return node;
}

/* ---- mini markdown — safe, tiny, enough for the Brief and methods --------------------
   Supported: ## headings, **bold**, *italic*, `code`, paragraphs, - lists.
   Built entirely from text nodes — corpus text can never become markup.
   `chipFn(token)` may map a [bracketed:token] to a Node (citation chips). */

export function mdInline(text, chipFn = null) {
  const out = [];
  // tokenize: chips first, then bold, italics, code
  const re = /(\[[a-z]+:[^\]\s]+\])|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1] && chipFn) {
      const node = chipFn(tok.slice(1, -1));
      out.push(node ?? tok);
    } else if (m[1]) {
      out.push(tok);
    } else if (m[2]) {
      out.push(el("strong", {}, tok.slice(2, -2)));
    } else if (m[3]) {
      out.push(el("em", {}, tok.slice(1, -1)));
    } else if (m[4]) {
      out.push(el("code", {}, tok.slice(1, -1)));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function mdBlock(md, { chipFn = null } = {}) {
  const root = el("div", { class: "md" });
  const lines = String(md ?? "").split(/\r?\n/);
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      root.append(el("p", {}, ...mdInline(para.join(" "), chipFn)));
      para = [];
    }
  };
  const flushList = () => {
    if (list) { root.append(list); list = null; }
  };
  for (const line of lines) {
    const t = line.trim();
    if (t === "") { flushPara(); flushList(); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const level = Math.min(4, h[1].length + 1); // # → h2 floor inside screens
      root.append(el(`h${level}`, { class: "md__h" }, ...mdInline(h[2], chipFn)));
      continue;
    }
    if (t.startsWith("- ")) {
      flushPara();
      if (!list) list = el("ul", { class: "md__list" });
      list.append(el("li", {}, ...mdInline(t.slice(2), chipFn)));
      continue;
    }
    para.push(t);
  }
  flushPara(); flushList();
  return root;
}

/* ---- downloads ------------------------------------------------------------------------ */

export function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---- misc ------------------------------------------------------------------------------- */

export const LEVEL_PRICE = "~150 units, ~35 min";

export function levelUpNudge({ construct, price = LEVEL_PRICE, onGo } = {}) {
  return el("footer", { class: "nudge" },
    el("span", { class: "nudge__mark", aria: { hidden: "true" } }, "◑ → ●"),
    el("p", { class: "nudge__line" },
      `Calibrate “${construct}” — ${price} of human coding — to make these numbers publication-grade.`),
    el("button", { class: "btn btn--quiet nudge__go", type: "button", onclick: onGo }, "Open the Calibration Studio →"),
  );
}

export function backLink(href, label = "Back") {
  return el("a", { class: "backlink", href: `#/${String(href).replace(/^#?\/?/, "")}` }, "← ", label);
}

/** Reading mode: rail recedes, the column owns the page; inspector stays summonable. */
export function setReading(on) {
  const app = document.getElementById("app");
  if (!app) return;
  if (on) app.setAttribute("data-reading", "1");
  else app.removeAttribute("data-reading");
}

/** Full bleed: everything recedes (the coding sprint). */
export function setFullbleed(on) {
  const app = document.getElementById("app");
  if (!app) return;
  if (on) app.setAttribute("data-fullbleed", "1");
  else app.removeAttribute("data-fullbleed");
}
