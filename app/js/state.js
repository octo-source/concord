// Single app store with path-addressed get/set/subscribe. DOM-free.
//
//   get("project.corpora")            → value at path (undefined if absent)
//   set("project.corpora", list)      → writes, notifies
//   update("ui.costUSD", n => n + x)  → functional write
//   subscribe("project", fn)          → fn(valueAtSubscribedPath, changedPath);
//                                       fires when the subscribed path, any
//                                       descendant, or any ancestor changes.
//                                       Returns unsubscribe.
//
// Screens (H2) read state and subscribe; api.js writes results in.

export function createStore(initial = {}) {
  let root = structuredClone(initial);
  const subs = new Map(); // path → Set<fn>

  const segs = (path) => (path === "" || path === undefined ? [] : String(path).split("."));

  function get(path) {
    let node = root;
    for (const key of segs(path)) {
      if (node === null || node === undefined) return undefined;
      node = node[key];
    }
    return node;
  }

  function set(path, value) {
    const parts = segs(path);
    if (parts.length === 0) {
      root = value;
    } else {
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
        node = node[key];
      }
      node[parts[parts.length - 1]] = value;
    }
    notify(path ?? "");
    return value;
  }

  function update(path, fn) {
    return set(path, fn(get(path)));
  }

  function subscribe(path, fn) {
    const key = path ?? "";
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => subs.get(key)?.delete(fn);
  }

  function related(subPath, changedPath) {
    if (subPath === changedPath || subPath === "" || changedPath === "") return true;
    return (
      subPath.startsWith(changedPath + ".") || // ancestor replaced wholesale
      changedPath.startsWith(subPath + ".")    // descendant changed
    );
  }

  function notify(changedPath) {
    for (const [subPath, fns] of subs) {
      if (!related(subPath, changedPath)) continue;
      const value = get(subPath);
      for (const fn of [...fns]) {
        try {
          fn(value, changedPath);
        } catch (err) {
          console.error(`state subscriber at "${subPath}" threw`, err);
        }
      }
    }
  }

  return { get, set, update, subscribe };
}

// the app store, with the shell's resting shape
export const store = createStore({
  project: null,        // full project graph once one is open
  projects: [],         // summaries for the switcher
  ui: {
    theme: "auto",      // "auto" | "light" | "dark"
    inspectorOpen: false,
    fullbleed: false,
    route: null,
    serverOk: null,     // null = unknown, true/false after health ping
    costUSD: 0,         // running session cost (chip in the top bar)
    privacyMode: null,  // mirrors project.privacyMode for the chip
  },
});

export const { get, set, update, subscribe } = store;
