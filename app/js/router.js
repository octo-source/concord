// Hash router: #/screen/:params → registered handler. Screens (H2) call
// register(); the shell calls start(). parseHash()/matchPath() are pure and
// probeable under node.
//
//   register("runs/:id", (mount, params, query) => element | {el, destroy})
//   navigate("runs/run_abc", {replace})
//   start({ root })            — listens to hashchange, resolves current hash
//
// A handler may return:
//   - an HTMLElement              → the router mounts it into root
//   - { el, destroy }             → mounted; destroy() called before next route
//   - nothing                     → the handler mounted into root itself
//
// The default route ("" — #/) renders the welcome empty state until a screens
// module registers something richer over it.

import { bus } from "./bus.js";
import { el } from "./dom.js";

const registry = []; // {pattern, segments, handler}

/** Register a route. Pattern segments starting with ":" capture params. */
export function register(pattern, handler) {
  const clean = String(pattern)
    .replace(/^#?\/?/, "")
    .replace(/\/$/, "");
  const existing = registry.findIndex((r) => r.pattern === clean);
  const entry = { pattern: clean, segments: clean === "" ? [] : clean.split("/"), handler };
  if (existing >= 0)
    registry[existing] = entry; // screens may override defaults
  else registry.push(entry);
  return () => {
    const i = registry.indexOf(entry);
    if (i >= 0) registry.splice(i, 1);
  };
}

/** Pure: "#/runs/run_a?x=1" → { path: "runs/run_a", segments, query: {x:"1"} } */
export function parseHash(hash) {
  let h = String(hash ?? "");
  h = h.replace(/^#/, "").replace(/^\//, "");
  const qIndex = h.indexOf("?");
  const query = {};
  if (qIndex >= 0) {
    for (const pair of h.slice(qIndex + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
      const v = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : "";
      query[k] = v;
    }
    h = h.slice(0, qIndex);
  }
  const path = h.replace(/\/$/, "");
  const segments = path === "" ? [] : path.split("/").map(decodeURIComponent);
  return { path, segments, query };
}

/** Pure: match segments against a registry list → {entry, params} | null. */
export function matchPath(segments, entries = registry) {
  for (const entry of entries) {
    if (entry.segments.length !== segments.length) continue;
    const params = {};
    let hit = true;
    for (let i = 0; i < segments.length; i++) {
      const pat = entry.segments[i];
      if (pat.startsWith(":")) params[pat.slice(1)] = segments[i];
      else if (pat !== segments[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return { entry, params };
  }
  return null;
}

let rootEl = null;
let activeTeardown = null;
let currentRoute = null;

/** Programmatic navigation. navigate("runs/run_abc"). */
export function navigate(path, { replace = false } = {}) {
  const target = "#/" + String(path).replace(/^#?\/?/, "");
  if (replace) {
    const url = new URL(location.href);
    url.hash = target;
    location.replace(url);
  } else {
    location.hash = target;
  }
}

/** Current resolved route: { path, params, query } | null. */
export function current() {
  return currentRoute;
}

async function resolve() {
  if (!rootEl) return;
  const { path, segments, query } = parseHash(location.hash);
  const found = matchPath(segments);

  if (activeTeardown) {
    try {
      activeTeardown();
    } catch (err) {
      console.error("route teardown threw", err);
    }
    activeTeardown = null;
  }
  rootEl.replaceChildren();

  currentRoute = { path, params: found?.params ?? {}, query };

  if (!found) {
    rootEl.append(notFoundView(path));
    bus.emit("route:changed", currentRoute);
    return;
  }
  try {
    const result = await found.entry.handler(rootEl, found.params, query);
    if (result instanceof HTMLElement) {
      rootEl.replaceChildren(result);
    } else if (result && result.el instanceof HTMLElement) {
      if (result.el !== rootEl) rootEl.replaceChildren(result.el);
      if (typeof result.destroy === "function") activeTeardown = result.destroy;
    }
  } catch (err) {
    console.error(`route "${path}" failed`, err);
    rootEl.replaceChildren(errorView(err));
  }
  // a new page starts at its top
  rootEl.closest(".app-work")?.scrollTo?.(0, 0);
  bus.emit("route:changed", currentRoute);
}

/** Boot the router against a mount element. */
export function start({ root }) {
  rootEl = root;
  window.addEventListener("hashchange", resolve);
  resolve();
}

/* ---- default views --------------------------------------------------------
   Quiet, instructive, never blank. The screens wave replaces the welcome
   route; these remain as the floor. */

function welcomeView() {
  return el(
    "div",
    { class: "empty-state welcome" },
    el("p", { class: "empty-state__mark", aria: { hidden: "true" } }, "◌ ◑ ● ◉"),
    el("h2", { class: "empty-state__title" }, "Concord measures qualitative text."),
    el(
      "p",
      { class: "empty-state__body" },
      "Import a corpus — survey open-ends, interviews, reviews — and Concord codes it into ",
      "numbers you can trace back to the text. Drop a file anywhere, or open the demo corpus.",
    ),
    el(
      "p",
      { class: "empty-state__hint" },
      "Every number shows its evidence level (◌ ◑ ● ◉); click any number to see the units behind it.",
    ),
  );
}

function notFoundView(path) {
  return el(
    "div",
    { class: "empty-state" },
    el("p", { class: "empty-state__mark", aria: { hidden: "true" } }, "◌"),
    el("h2", { class: "empty-state__title" }, "Page not found."),
    el(
      "p",
      { class: "empty-state__body" },
      "No screen matches ",
      el("code", {}, `#/${path}`),
      ". ",
      el("a", { href: "#/" }, "Return to the start"),
      ".",
    ),
  );
}

function errorView(err) {
  return el(
    "div",
    { class: "empty-state" },
    el(
      "p",
      { class: "empty-state__mark empty-state__mark--signal", aria: { hidden: "true" } },
      "◌",
    ),
    el("h2", { class: "empty-state__title" }, "This page failed to load."),
    el("p", { class: "empty-state__body" }, String(err?.message ?? err)),
  );
}

// the floor route — H2 overrides via register("", …)
register("", () => welcomeView());
