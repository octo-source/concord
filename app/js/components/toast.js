// Quiet notifications. A shelf at the bottom of the page; each toast
// composes in (8px rise + fade, 200ms), holds, and dissolves. Nothing
// bounces, nothing blocks. Hovering a toast pauses its clock.

import { el } from "../dom.js";

let shelf = null;

/** Mount the shelf (idempotent). Called by main.js and the gallery. */
export function init(host = document.body) {
  if (shelf && shelf.isConnected) return shelf;
  shelf = el("div", {
    class: "toast-shelf",
    role: "status",
    aria: { live: "polite", relevant: "additions" },
  });
  host.append(shelf);
  return shelf;
}

/**
 * toast("Instrument frozen at ●", { kind, duration, detail }) → dismiss()
 *   kind      "info" (default) | "success" | "warn" | "error"
 *   duration  ms on screen (default 4500; errors 8000; 0 = sticky)
 *   detail    optional second line (mono for ids/costs — pass {data:true})
 */
export function toast(message, { kind = "info", duration, detail, data = false } = {}) {
  if (!shelf || !shelf.isConnected) init();
  const ms = duration ?? (kind === "error" ? 8000 : 4500);

  const node = el("div", { class: `toast toast--${kind}` },
    el("div", { class: "toast__body" },
      el("p", { class: "toast__message" }, message),
      detail ? el("p", { class: `toast__detail${data ? " data" : ""}` }, detail) : null,
    ),
    el("button", {
      class: "toast__close",
      type: "button",
      aria: { label: "Dismiss notification" },
      onclick: () => dismiss(),
    }, "×"),
  );

  let timer = null;
  let remaining = ms;
  let startedAt = 0;

  function arm() {
    if (remaining <= 0) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  }
  function disarm() {
    if (timer) clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - startedAt;
  }

  function dismiss() {
    if (!node.isConnected) return;
    if (timer) clearTimeout(timer);
    node.classList.add("toast--leaving");
    node.addEventListener("transitionend", () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400); // safety when transitions are off
  }

  node.addEventListener("mouseenter", disarm);
  node.addEventListener("mouseleave", arm);

  shelf.append(node);
  // compose in just after the initial style resolves. A timeout, not rAF:
  // rAF never fires in hidden/background documents and the toast would be
  // stranded at opacity 0; a 20ms timeout lets the transition run in the
  // foreground and still lands the resting state in the background.
  setTimeout(() => node.classList.add("toast--in"), 20);
  if (ms > 0) arm();
  return dismiss;
}

export const info = (m, o = {}) => toast(m, { ...o, kind: "info" });
export const success = (m, o = {}) => toast(m, { ...o, kind: "success" });
export const warn = (m, o = {}) => toast(m, { ...o, kind: "warn" });
export const error = (m, o = {}) => toast(m, { ...o, kind: "error" });
