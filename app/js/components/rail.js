// The left rail — the project's table of contents. Sections (Corpora,
// Constructs, Instruments, Runs, Analyses) with items that wear their ladder
// marks inline. Roving tabindex: one tab stop for the whole tree, arrows to
// move, Enter/Space to open. Empty sections show a quiet instructive line.

import { el, clear } from "../dom.js";
import * as ladder from "./ladder.js";
import * as glyph from "./glyph.js";

export const DEFAULT_SECTIONS = [
  { id: "corpora", title: "Corpora", emptyHint: "Drop a file anywhere to begin." },
  { id: "constructs", title: "Constructs", emptyHint: "What do you want to measure?" },
  { id: "instruments", title: "Instruments", emptyHint: "Compiled from constructs." },
  { id: "runs", title: "Runs", emptyHint: "Nothing has been measured yet." },
  { id: "analyses", title: "Analyses", emptyHint: "Crosstabs, models, and triangulation. Corrected where gold labels exist." },
];

/**
 * render({ sections, activeId, onSelect }) → <nav class="rail">
 *   sections [{ id, title, emptyHint?, items: [{ id, label, level?, count?,
 *               authoredBy?, humanTouched?, href? }] }]
 *   activeId currently-open item id
 *   onSelect (item, sectionId) — called on click/Enter; if the item has an
 *            href, the rail navigates instead.
 *
 * Returned element exposes .update({sections, activeId}) for live refresh.
 */
export function render({ sections = DEFAULT_SECTIONS, activeId = null, onSelect } = {}) {
  const nav = el("nav", { class: "rail", aria: { label: "Project" } });
  build(nav, { sections, activeId, onSelect });

  nav.addEventListener("keydown", (e) => {
    const items = [...nav.querySelectorAll(".rail__item")];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(items.length - 1, idx + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    if (next >= 0 && items[next]) {
      roveTo(items, items[next]);
      items[next].focus();
    }
  });

  nav.update = (props) => build(nav, { sections, activeId, onSelect, ...props });
  return nav;
}

function build(nav, { sections, activeId, onSelect }) {
  clear(nav);
  let firstItem = null;
  let activeItem = null;

  for (const section of sections) {
    const items = section.items ?? [];
    const list = el("ul", { class: "rail__list", role: "list" });

    for (const item of items) {
      const isActive = item.id === activeId;
      const btn = el("button", {
        class: `rail__item${isActive ? " rail__item--active" : ""}`,
        type: "button",
        tabindex: "-1",
        title: item.title ?? null, // full text when the label is truncated
        dataset: { id: item.id, section: section.id },
        aria: { current: isActive ? "true" : null },
        onclick: () => {
          if (item.href) location.hash = item.href;
          onSelect?.(item, section.id);
        },
      },
        el("span", { class: "rail__item-label" },
          item.label,
          glyph.render({ authoredBy: item.authoredBy, humanTouched: item.humanTouched ?? true }),
        ),
        item.count !== undefined && item.count !== null
          ? el("span", { class: "rail__item-count data" }, String(item.count))
          : null,
        item.level ? ladder.render({ level: item.level, size: "sm" }) : null,
      );
      list.append(el("li", {}, btn));
      if (!firstItem) firstItem = btn;
      if (isActive) activeItem = btn;
    }

    nav.append(
      el("section", { class: "rail__section", aria: { label: section.title } },
        el("h2", { class: "rail__heading overline" },
          section.title,
          items.length ? el("span", { class: "rail__heading-count data" }, String(items.length)) : null,
        ),
        items.length
          ? list
          : el("p", { class: "rail__empty" }, section.emptyHint ?? "Nothing here yet."),
      ),
    );
  }

  // roving tabindex: the active item (else the first) is the single tab stop
  const entry = activeItem ?? firstItem;
  if (entry) entry.tabIndex = 0;
}

function roveTo(items, target) {
  for (const item of items) item.tabIndex = item === target ? 0 : -1;
}
