// Renameable title — the object's name with a quiet pencil affordance.
// render({value, fallback, onSave, label}) → <span class="renameable">.
// Shows `value || fallback`; the pencil swaps in an inline input seeded with
// the shown text. Enter or blur saves through onSave(next) (only a real,
// changed name is sent); Escape cancels. onSave may throw — the old name is
// kept and the caller's toast explains; on success the new name paints in
// place, so the screen never needs a full re-render to show its title.

import { el } from "../dom.js";

export function render({ value = null, fallback = "", onSave, label = "Rename" } = {}) {
  const root = el("span", { class: "renameable" });
  let current = value || null;

  const shown = () => current || fallback || "";

  function paint() {
    root.replaceChildren(
      el("span", { class: "renameable__text" }, shown()),
      el("button", {
        class: "renameable__edit", type: "button",
        title: label, aria: { label: `${label} — currently “${shown()}”` },
        onclick: () => edit(),
      }, "✎"),
    );
  }

  function edit() {
    const input = el("input", {
      class: "input renameable__input",
      value: shown(),
      aria: { label },
    });
    let settled = false;
    const finish = async (save) => {
      if (settled) return;
      settled = true;
      const next = String(input.value ?? "").trim();
      if (!save || !next || next === shown()) { paint(); return; }
      input.disabled = true;
      try {
        await onSave?.(next);
        current = next;
      } catch { /* the caller toasts the failure; the old name stands */ }
      paint();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    root.replaceChildren(input);
    input.focus();
    input.select();
  }

  paint();
  return root;
}
