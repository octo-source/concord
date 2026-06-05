// Director-attribution glyph — the small ✦ that sits beside anything the
// Director drafted and a human has not yet touched. The mark is a promise of
// provenance, not a badge of quality: edit (or accept) the artifact and the
// glyph dissolves. Returns null when humanTouched — the removed state IS the
// adopted state.

import { el } from "../dom.js";

export const GLYPH = "✦";
export const TIP = "Drafted by the Director — edit to adopt.";

/**
 * render({ humanTouched, authoredBy }) → <span class="dglyph"> | null
 * Renders nothing unless the artifact is Director-authored and untouched.
 */
export function render({ humanTouched = false, authoredBy = "director" } = {}) {
  if (humanTouched || authoredBy !== "director") return null;
  return el("span", {
    class: "dglyph",
    role: "img",
    tabindex: "0",
    aria: { label: TIP },
  },
    el("span", { class: "dglyph__mark", aria: { hidden: "true" } }, GLYPH),
    // visual only — aria-label above carries the text
    el("span", { class: "dglyph__pop", role: "tooltip", aria: { hidden: "true" } }, TIP),
  );
}

/**
 * For live views: swap the glyph out the moment an artifact is touched.
 * update(existingEl, {humanTouched:true}) removes it with the standard
 * compose-out (150ms fade) and resolves when gone.
 */
export function update(glyphEl, { humanTouched = false } = {}) {
  if (!glyphEl || !humanTouched) return;
  glyphEl.classList.add("dglyph--adopted");
  const remove = () => glyphEl.remove();
  glyphEl.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 300); // safety if transitions are off
}
