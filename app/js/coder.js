// The human coder page behind /coder.html — a single-purpose screen for one
// blind coder, served by the RESTRICTED listener (server/index.js
// startCoderListener). It drives exactly two routes and nothing else:
//
//   GET  /api/coder/next   → {unit: {id, text, pos} | null, construct, progress}
//   POST /api/coder/label  → progress   ({label} or {uncodable: true}, + memo/flag)
//
// The coder id is BOUND server-side at listener start; ?coder=<id> in this
// page's URL is display only. Machine labels, other coders' labels and
// adjudicated answers are not reachable from this listener at all — that is
// the blind contract the header states.
//
// Keyboard-first: 1–9 label, u can't-code, f flag, m memo, Esc leaves the
// memo field. Submitting advances to the next unit automatically.
import { el, clear } from "./dom.js";

const mount = document.getElementById("coder-mount");
const coderParam = new URLSearchParams(location.search).get("coder");
// Bound to this listener instance at startCoderListener() time; carried in
// the page URL (?t=) and echoed back on every call so a LAN neighbor who
// doesn't have the session link can't read units or submit labels.
const coderToken = new URLSearchParams(location.search).get("t");

const state = {
  construct: null,
  progress: null,
  unit: null,
  inFlight: false,
  fields: null, // {memo, flagBox} for the unit on screen
};

/* ---- the only two calls this page makes -------------------------------- */

async function call(method, path, body) {
  let res;
  const headers = { "x-coder-token": coderToken ?? "" };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    res = await fetch(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(`the server did not answer (${err.message})`, { cause: err });
  }
  let envelope = null;
  try {
    envelope = JSON.parse(await res.text());
  } catch {
    /* non-JSON body */
  }
  if (envelope && envelope.ok === true) return envelope.data;
  throw new Error(envelope?.error?.message ?? `${method} ${path} → ${res.status}`);
}

const getNext = () => call("GET", "/api/coder/next");
const postLabel = (payload) => call("POST", "/api/coder/label", payload);

/* ---- codebook (left, pinned) -------------------------------------------- */

function codebookPanel() {
  const c = state.construct;
  if (!c) {
    return el(
      "aside",
      { class: "coder__book", aria: { label: "Codebook" } },
      el(
        "p",
        { class: "faint" },
        "No codebook is recorded for this gold set — code from the researcher's instructions.",
      ),
    );
  }
  const cats = c.categories ?? [];
  return el(
    "aside",
    { class: "coder__book", aria: { label: "Codebook" } },
    el("p", { class: "overline" }, `codebook${c.type ? ` · ${c.type}` : ""}`),
    el("h2", { class: "coder__bookname" }, c.name ?? "Construct"),
    el("p", { class: "coder__bookdef" }, c.definition ?? "(no definition)"),
    c.criteria?.include?.length
      ? el(
          "p",
          { class: "coder__bookrule" },
          el("strong", {}, "Include: "),
          c.criteria.include.join(" · "),
        )
      : null,
    c.criteria?.exclude?.length
      ? el(
          "p",
          { class: "coder__bookrule" },
          el("strong", {}, "Exclude: "),
          c.criteria.exclude.join(" · "),
        )
      : null,
    c.edgeCases?.length
      ? el(
          "div",
          { class: "coder__bookrule" },
          el("strong", {}, "Borderline cases:"),
          el(
            "ul",
            { class: "coder__edgelist", role: "list" },
            ...c.edgeCases.map((rule) => el("li", {}, rule)),
          ),
        )
      : null,
    c.examples?.length
      ? el(
          "details",
          { class: "coder__examples" },
          el("summary", { class: "coder__booksummary" }, `Worked examples (${c.examples.length})`),
          ...c.examples.map((ex) =>
            el("p", { class: "coder__bookrule" }, el("strong", {}, `${ex.label}: `), ex.text),
          ),
        )
      : null,
    cats.length
      ? el(
          "div",
          {},
          el("p", { class: "overline coder__bookcats" }, "labels · number keys"),
          el(
            "ul",
            { class: "coder__catlist", role: "list" },
            ...cats.map((cat, i) =>
              el(
                "li",
                { class: "coder__catrow" },
                el("kbd", {}, String(i + 1)),
                el("span", {}, cat.label ?? String(cat.value)),
              ),
            ),
          ),
        )
      : null,
    c.scale
      ? el(
          "p",
          { class: "coder__bookrule" },
          el("strong", {}, "Scale: "),
          `a number from ${c.scale.min} to ${c.scale.max}`,
        )
      : null,
    el(
      "p",
      { class: "coder__bookrule faint" },
      el("kbd", {}, "u"),
      " marks a unit you cannot honestly code — it goes to the researcher for adjudication.",
    ),
  );
}

/* ---- the unit and its controls (main) ------------------------------------ */

function cantCodeBtn() {
  return el(
    "button",
    {
      class: "coder__key coder__key--meta",
      type: "button",
      dataset: { value: "__uncodable__" },
      title:
        "You cannot honestly assign a label — the unit goes to the researcher for adjudication",
      onclick: () => submit({ uncodable: true }),
    },
    el("kbd", {}, "u"),
    el("span", {}, "can't code"),
  );
}

function controlsFor(construct) {
  const cats = construct?.categories ?? [];
  if (cats.length) {
    return el(
      "div",
      { class: "coder__keys", role: "toolbar", aria: { label: "Labels" } },
      ...cats.map((cat, i) =>
        el(
          "button",
          {
            class: "coder__key",
            type: "button",
            dataset: { value: String(cat.value) },
            onclick: () => submit({ label: cat.value }),
          },
          el("kbd", {}, String(i + 1)),
          el("span", {}, cat.label ?? String(cat.value)),
        ),
      ),
      cantCodeBtn(),
    );
  }
  // continuous (scale) and free-text constructs: one field, Enter submits
  const scale = construct?.scale ?? null;
  const input = el("input", {
    class: "input coder__freelabel",
    type: scale ? "number" : "text",
    ...(scale ? { min: scale.min, max: scale.max, step: "any" } : {}),
    placeholder: scale ? `${scale.min}–${scale.max}` : "label…",
    "aria-label": scale ? `Label — a number from ${scale.min} to ${scale.max}` : "Label",
  });
  return el(
    "form",
    {
      class: "coder__keys",
      onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v === "") return;
        if (scale) {
          // a non-numeric entry on a scale construct would Number() to NaN and
          // serialize to null — submit a number only when it really is one
          const num = Number(v);
          if (!Number.isFinite(num)) {
            input.focus();
            return;
          }
          submit({ label: num });
        } else {
          submit({ label: v });
        }
      },
    },
    input,
    el("button", { class: "btn btn--primary", type: "submit" }, "Submit label"),
    cantCodeBtn(),
  );
}

function workPanel() {
  const total = state.progress?.total ?? 0;
  const done = state.progress?.done ?? 0;
  const memo = el("textarea", {
    class: "input textarea coder__memo",
    rows: 2,
    "aria-label": "Memo — saved with this unit's submission",
    placeholder: "anything the researcher should know about this unit",
  });
  const flagBox = el("input", {
    type: "checkbox",
    "aria-label": "Flag this unit for the researcher",
  });
  state.fields = { memo, flagBox };

  return el(
    "section",
    { class: "coder__work" },
    el(
      "div",
      { class: "coder__progress" },
      el(
        "span",
        { class: "coder__progresstrack", aria: { hidden: "true" } },
        el("span", {
          class: "coder__progressfill",
          style: { width: `${total ? (done / total) * 100 : 0}%` },
        }),
      ),
      el(
        "span",
        { class: "data coder__progresstext", role: "status" },
        `unit ${Math.min(done + 1, total)} of ${total}`,
      ),
      el(
        "span",
        { class: "data faint" },
        `coding as ${state.progress?.coderId ?? coderParam ?? "—"}`,
      ),
    ),
    el("p", { class: "coder__unitid data faint" }, state.unit.id),
    el("blockquote", { class: "coder__text" }, state.unit.text ?? "(unit text unavailable)"),
    controlsFor(state.construct),
    el(
      "div",
      { class: "coder__extras" },
      el(
        "label",
        { class: "coder__extra" },
        el("span", { class: "overline" }, "memo ", el("kbd", {}, "m")),
        memo,
      ),
      el(
        "label",
        { class: "coder__flag" },
        flagBox,
        el("span", {}, "flag for the researcher ", el("kbd", {}, "f")),
      ),
    ),
  );
}

/* ---- states --------------------------------------------------------------- */

function render() {
  banner?.remove();
  banner = null;
  clear(mount);
  if (!state.unit) {
    renderDone();
    return;
  }
  mount.append(el("div", { class: "coder__grid" }, codebookPanel(), workPanel()));
}

function renderDone() {
  const p = state.progress ?? {};
  state.fields = null;
  clear(mount).append(
    el(
      "div",
      { class: "coder__done" },
      el(
        "p",
        { class: "coder__doneline" },
        "Your coding pass is complete — hand back to the researcher.",
      ),
      el(
        "p",
        { class: "faint" },
        `${p.done ?? 0} of ${p.total ?? 0} units handled` +
          ((p.uncodable ?? 0) > 0 ? ` · ${p.uncodable} marked can't-code` : "") +
          ((p.flagged ?? 0) > 0 ? ` · ${p.flagged} flagged` : "") +
          ` · coding as ${p.coderId ?? coderParam ?? "—"}`,
      ),
    ),
  );
}

function renderLoadError(err) {
  state.fields = null;
  clear(mount).append(
    el(
      "div",
      { class: "coder__error", role: "alert" },
      el("p", {}, `Could not load the coding queue: ${err.message}.`),
      el(
        "p",
        { class: "faint" },
        "The researcher's Concord session may have ended — ask them to start it again.",
      ),
      el("button", { class: "btn", type: "button", onclick: load }, "Retry"),
    ),
  );
}

let banner = null;
function showBanner(message, retry) {
  banner?.remove();
  banner = el(
    "div",
    { class: "coder__error", role: "alert" },
    el("p", {}, message),
    el(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: () => {
          banner?.remove();
          banner = null;
          retry();
        },
      },
      "Retry",
    ),
  );
  mount.prepend(banner);
}

/* ---- actions --------------------------------------------------------------- */

function pulse(value) {
  const btn = mount.querySelector(`[data-value="${CSS.escape(value)}"]`);
  btn?.classList.add("coder__key--hit");
  setTimeout(() => btn?.classList.remove("coder__key--hit"), 220);
}

async function submit(disposition) {
  if (state.inFlight || !state.unit) return;
  state.inFlight = true;
  pulse(disposition.uncodable ? "__uncodable__" : String(disposition.label));
  const payload = {
    unitId: state.unit.id,
    ...disposition,
    memo: state.fields?.memo.value.trim() || undefined,
    flag: state.fields?.flagBox.checked || undefined,
  };
  try {
    state.progress = await postLabel(payload);
  } catch (err) {
    state.inFlight = false;
    // the unit (and the memo/flag fields) stay on screen — retry resubmits
    showBanner(`The submission did not save: ${err.message}.`, () => submit(disposition));
    return;
  }
  try {
    const view = await getNext();
    state.construct = view.construct ?? state.construct;
    state.progress = view.progress ?? state.progress;
    state.unit = view.unit;
    state.inFlight = false;
    render();
  } catch (err) {
    state.inFlight = false;
    showBanner(`The label saved, but the next unit did not load: ${err.message}.`, load);
  }
}

async function load() {
  clear(mount).append(el("p", { class: "faint", role: "status" }, "Loading your queue…"));
  try {
    const view = await getNext();
    state.construct = view.construct;
    state.progress = view.progress;
    state.unit = view.unit;
    render();
  } catch (err) {
    renderLoadError(err);
  }
}

/* ---- keyboard --------------------------------------------------------------- */

document.addEventListener("keydown", (e) => {
  if (
    e.target instanceof HTMLElement &&
    (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")
  ) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (!state.unit || state.inFlight) return;
  if (e.key === "u") {
    submit({ uncodable: true });
    return;
  }
  if (e.key === "f" && state.fields) {
    state.fields.flagBox.checked = !state.fields.flagBox.checked;
    return;
  }
  if (e.key === "m" && state.fields) {
    e.preventDefault();
    state.fields.memo.focus();
    return;
  }
  const cats = state.construct?.categories ?? [];
  const num = Number(e.key);
  if (Number.isInteger(num) && num >= 1 && num <= cats.length)
    submit({ label: cats[num - 1].value });
});

load();
