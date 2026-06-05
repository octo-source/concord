// Tiny pub/sub. One shared bus instance for app-wide events
// ("inspector:open", "toast", "route:changed"), plus createBus() for
// component-local channels. DOM-free — probeable under node.

export function createBus() {
  const channels = new Map(); // event → Set<fn>

  function on(event, fn) {
    if (!channels.has(event)) channels.set(event, new Set());
    channels.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    channels.get(event)?.delete(fn);
  }

  function once(event, fn) {
    const unsub = on(event, (payload) => {
      unsub();
      fn(payload);
    });
    return unsub;
  }

  function emit(event, payload) {
    const set = channels.get(event);
    if (!set) return 0;
    // snapshot: handlers may unsubscribe (or subscribe) mid-emit
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`bus handler for "${event}" threw`, err);
      }
    }
    return set.size;
  }

  return { on, off, once, emit };
}

export const bus = createBus();
