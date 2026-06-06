// Model picker — a searchable combobox over the model catalog. Replaces the
// bare <select>: 344 OpenRouter models do not fit in an option list. Type to
// filter (id/name substring); rows group under provider headers and carry the
// catalog facts a researcher picks on: id, context window, price per 1M
// in/out, and capability badges. The panel is a dropdown under the input,
// never a modal. Arrow keys move, Enter picks, Escape closes.
//
// Capability fields on catalog entries (absent on older servers — absence is
// treated as "unknown, assume supported"):
//   structuredOutput: boolean — provider enforces the label schema natively
//   noTemperature:    boolean — reasoning-class; temperature/seed are ignored
//   params:           string[] — raw provider-supported parameter names
//                     (OpenRouter); may be absent on other providers
//
//   render({ catalog, value, onPick, structuredFilter, showSelected,
//            disabled, label, placeholder }) → { el, setValue }
//     catalog  {provider: [entry]} — the live /api/catalog/models map
//     value    {provider, model} | null — current selection (chip + badges)
//     onPick   ({provider, entry}) — fires on every selection
//     structuredFilter  true → "structured output only" checkbox, checked;
//                       false → checkbox unchecked; undefined → no checkbox
//     showSelected      false → no selection chip (panel juror add: the
//                       juror card is the result); input clears after pick
//
//   findEntry(catalog, provider, modelId) → entry | null
//   supportsParam(entry, name) → true | false | null  (null = catalog does
//     not say — assume the provider supports it)
//   capBadges(entry) → chip nodes for the entry's capabilities

import { el, clear, uid } from "../dom.js";
import { fmtCompact } from "../format.js";

const STRUCTURED_FILTER_LABEL =
  "Only models with native structured output (recommended for judges) — others work via slower repair-based prompting";

/* ---- catalog lookups --------------------------------------------------------- */

export function findEntry(catalog, provider, modelId) {
  if (!provider || !modelId) return null;
  return (catalog?.[provider] ?? []).find((m) => m.id === modelId) ?? null;
}

// Raw provider parameter names that satisfy each of OUR param controls.
const PARAM_ALIASES = {
  temperature: ["temperature"],
  seed: ["seed"],
  maxTokens: ["max_tokens", "max_completion_tokens", "maxTokens"],
};

/**
 * Does this catalog entry support a parameter? true / false / null —
 * null means the catalog carries no parameter data for the entry, and the
 * caller should assume support (the provider strips what it cannot use).
 */
export function supportsParam(entry, name) {
  if (!entry) return null;
  if (name === "temperature" && entry.noTemperature) return false;
  if (Array.isArray(entry.params)) {
    const aliases = PARAM_ALIASES[name] ?? [name];
    return aliases.some((a) => entry.params.includes(a));
  }
  return null;
}

/** Capability badges for an entry — the same chips everywhere a model shows. */
export function capBadges(entry) {
  if (!entry) return [];
  const badges = [];
  if (entry.structuredOutput) {
    badges.push(el("span", { class: "chip", title: "Native structured output — the provider enforces the label schema" }, "structured ✓"));
  }
  if (entry.noTemperature) {
    badges.push(el("span", { class: "chip chip--ghost", title: "Reasoning-class model — temperature is ignored" }, "no temp"));
  }
  const inP = entry.pricing?.inUSDper1M;
  const outP = entry.pricing?.outUSDper1M;
  if (inP === 0 && outP === 0) {
    badges.push(el("span", { class: "chip", title: "No per-token cost" }, "$0"));
  }
  return badges;
}

/* ---- the picker ---------------------------------------------------------------- */

export function render({
  catalog = {},
  value = null,
  onPick = null,
  structuredFilter = undefined,
  showSelected = true,
  disabled = false,
  label = "Model",
  placeholder = "Search models — type to filter…",
} = {}) {
  const providers = Object.entries(catalog ?? {});
  const total = providers.reduce((n, [, models]) => n + (models?.length ?? 0), 0);
  // Capability data may be missing entirely (older server): the structured
  // filter would then hide every model — disarm it instead of lying.
  const hasCapData = providers.some(([, models]) => (models ?? []).some((m) => m.structuredOutput !== undefined));

  let selected = value?.provider && value?.model
    ? { provider: value.provider, entry: findEntry(catalog, value.provider, value.model) }
    : null;
  let structuredOnly = structuredFilter === true && hasCapData;
  let open = false;
  let rows = []; // visible options, flat: [{provider, entry, node}]
  let active = -1;

  const listId = uid("mpick");

  const input = el("input", {
    class: "input modelpicker__input",
    type: "text",
    placeholder,
    disabled,
    role: "combobox",
    "aria-expanded": "false",
    aria: { autocomplete: "list", controls: listId, label },
    oninput: () => { openPanel(); paintList(); },
    onfocus: () => openPanel(),
    onclick: () => openPanel(),
    onkeydown: onKey,
  });

  const list = el("div", { class: "modelpicker__list", role: "listbox", id: listId, aria: { label: `${label} catalog` } });
  const count = el("p", { class: "modelpicker__count faint data" });

  const filterBox = (structuredFilter !== undefined && hasCapData)
    ? el("label", { class: "switch modelpicker__filter" },
        el("input", {
          type: "checkbox", checked: structuredOnly,
          onchange: (e) => { structuredOnly = e.target.checked; paintList(); input.focus(); },
        }),
        el("span", {}, STRUCTURED_FILTER_LABEL))
    : null;

  const panel = el("div", { class: "modelpicker__panel", hidden: true }, filterBox, list, count);
  const selectedHost = showSelected ? el("span", { class: "modelpicker__selected" }) : null;

  const root = el("div", { class: "modelpicker" },
    el("div", { class: "modelpicker__field" }, input, panel),
    selectedHost,
  );

  /* -- selection chip: provider · id, plus its badges -- */
  const paintSelected = () => {
    if (!selectedHost) return;
    clear(selectedHost);
    if (!selected?.entry && !(selected?.provider && value?.model)) {
      selectedHost.append(el("span", { class: "faint" }, "no model selected"));
      return;
    }
    const id = selected.entry?.id ?? value?.model;
    selectedHost.append(
      el("span", { class: "chip chip--machine", title: selected.entry?.name ?? id }, `${selected.provider} · ${id}`),
      ...capBadges(selected.entry),
    );
  };

  /* -- the grouped, filtered list -- */
  const matches = (entry) => {
    if (structuredOnly && !entry.structuredOutput) return false;
    const q = input.value.trim().toLowerCase();
    if (!q) return true;
    return String(entry.id).toLowerCase().includes(q)
      || String(entry.name ?? "").toLowerCase().includes(q);
  };

  function paintList() {
    clear(list);
    rows = [];
    active = -1;
    for (const [provider, models] of providers) {
      const hits = (models ?? []).filter(matches);
      if (!hits.length) continue;
      list.append(el("p", { class: "overline modelpicker__group", role: "presentation" }, provider));
      for (const entry of hits) {
        const i = rows.length;
        const isCurrent = selected?.provider === provider && selected?.entry?.id === entry.id;
        const node = el("div", {
          class: "modelpicker__row",
          role: "option",
          id: `${listId}-opt-${i}`,
          "aria-selected": isCurrent ? "true" : "false",
          title: entry.name ?? entry.id,
          onmousedown: (e) => e.preventDefault(), // keep focus on the input
          onclick: () => pick(i),
          onmousemove: () => setActive(i, false),
        },
          el("span", { class: "modelpicker__id data" }, entry.id),
          el("span", { class: "modelpicker__meta data" },
            entry.ctx ? el("span", { title: "context window (tokens)" }, `${fmtCompact(entry.ctx)} ctx`) : null,
            el("span", { title: "price per 1M tokens, in/out (USD)" },
              `$${entry.pricing?.inUSDper1M ?? 0}/$${entry.pricing?.outUSDper1M ?? 0}`),
            ...capBadges(entry)),
        );
        list.append(node);
        rows.push({ provider, entry, node });
      }
    }
    if (!rows.length) {
      list.append(el("p", { class: "modelpicker__empty faint" },
        structuredOnly
          ? "No matches with the structured-output filter on — uncheck it to see every model."
          : "No models match."));
    }
    count.textContent = `${rows.length} of ${total} models`;
    input.setAttribute("aria-activedescendant", "");
  }

  function setActive(i, scroll = true) {
    if (active >= 0) rows[active]?.node.classList.remove("modelpicker__row--active");
    active = i;
    if (active >= 0 && rows[active]) {
      rows[active].node.classList.add("modelpicker__row--active");
      input.setAttribute("aria-activedescendant", rows[active].node.id);
      if (scroll) rows[active].node.scrollIntoView({ block: "nearest" });
    } else {
      input.setAttribute("aria-activedescendant", "");
    }
  }

  function pick(i) {
    const row = rows[i];
    if (!row) return;
    selected = { provider: row.provider, entry: row.entry };
    value = { provider: row.provider, model: row.entry.id };
    input.value = "";
    closePanel();
    paintSelected();
    onPick?.({ provider: row.provider, entry: row.entry });
  }

  function openPanel() {
    if (open || disabled) return;
    open = true;
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    paintList();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function onKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { openPanel(); return; }
      if (!rows.length) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((active + delta + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      if (open && active >= 0) {
        e.preventDefault();
        pick(active);
      }
    } else if (e.key === "Escape") {
      if (open) {
        // the picker consumes its own Escape — sheets stay open
        e.stopPropagation();
        closePanel();
      }
    }
  }

  // close when focus leaves the whole widget (tab away, click elsewhere)
  root.addEventListener("focusout", (e) => {
    if (!root.contains(e.relatedTarget)) closePanel();
  });

  paintSelected();

  return {
    el: root,
    setValue(next) {
      value = next;
      selected = next?.provider && next?.model
        ? { provider: next.provider, entry: findEntry(catalog, next.provider, next.model) }
        : null;
      paintSelected();
    },
  };
}
