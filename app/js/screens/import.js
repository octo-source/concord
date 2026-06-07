// Import — #/p/:slug/import — the door the corpus walks through. The global
// drag-anywhere overlay (main.js) routes dropped files here; the screen also
// offers its own quiet drop target and a file picker. Parsing yields a sheet:
// detected columns as editable role chips with confidence, a 20-row preview,
// issues as gentle annotations (never blockers), a unitization choice, and
// ONE confirm button.
//
// Live contract:
//   POST import          → {importId, mapping: {columns: [{name, role,
//                           confidence, stats}]} | null, preview: [...rows],
//                           issues: [...]}
//   POST import/confirm  → {importId, mapping: {textColumn}, unitization:
//                           {scheme}, pii: "off"|"scan"|"pseudonymize"} →
//                           {corpusId, unitCount, junkQueue: {counts: {na,
//                           dup, bot, …}, flagged}, pii: {mode, counts?}}

import { el, clear } from "../dom.js";
import { store } from "../state.js";
import api, { ApiError } from "../api.js";
import { fixturesEnabled } from "../fixtures.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as table from "../components/table.js";
import { fmtCount, fmtPct } from "../format.js";
import { screenHead, section, emptyState, loadingView, errorView, ensureProject, refreshProject } from "./_shared.js";

export const route = "p/:slug/import";
export const title = "Import";

const ROLES = ["text", "categorical", "numeric", "date", "id", "ignore"];

export function render(mount, params) {
  ensureProject(params.slug).catch(() => { /* a missing project still allows the drop affordance */ });

  const pending = store.get("ui.pendingImport");
  if (pending) {
    store.set("ui.pendingImport", null);
    beginUpload(mount, params, pending);
    return;
  }

  clear(mount).append(
    screenHead({ overline: "Import", title: "Bring a corpus." }),
    dropTarget(mount, params),
  );
}

function dropTarget(mount, params) {
  const input = el("input", {
    type: "file", class: "sr-only", id: "import-file",
    accept: ".csv,.tsv,.xlsx,.docx,.pdf,.txt,.vtt,.srt,.json",
    onchange: (e) => {
      const file = e.target.files?.[0];
      if (file) beginUpload(mount, params, file);
    },
  });

  const zone = el("div", {
    class: "dropzone",
    ondragover: (e) => { e.preventDefault(); zone.classList.add("dropzone--over"); },
    ondragleave: () => zone.classList.remove("dropzone--over"),
    ondrop: (e) => {
      e.preventDefault();
      zone.classList.remove("dropzone--over");
      const file = e.dataTransfer?.files?.[0];
      if (file) beginUpload(mount, params, file);
    },
  },
    emptyState({
      mark: "⇣",
      title: "Drop a file anywhere.",
      body: "CSV, XLSX, DOCX, PDF, plain text, or VTT/SRT transcripts. Concord proposes the column mapping; you stay the editor.",
      hint: "Files parse locally. Nothing leaves this machine at import.",
      actions: [
        el("label", { class: "btn btn--primary", for: "import-file" }, "Choose a file…"),
      ],
    }),
    input,
  );
  return zone;
}

async function beginUpload(mount, params, file) {
  clear(mount).append(
    screenHead({ overline: "Import", title: file.name ?? "Parsing…" }),
    loadingView(`Parsing ${file.name ?? "file"} locally…`),
  );
  try {
    const proposal = await api.imports.upload(params.slug, file);
    renderSheet(mount, params, proposal, file);
  } catch (err) {
    clear(mount).append(
      screenHead({ overline: "Import", title: "The file did not parse." }),
      errorView(err, { retry: () => render(mount, params) }),
    );
  }
}

function renderSheet(mount, params, proposal, file) {
  clear(mount);
  // live: column roles ride under mapping.columns (null for column-less docs)
  const columns = (proposal.mapping?.columns ?? []).map((c) => ({ ...c }));
  const tabular = columns.length > 0;
  const preview = proposal.preview ?? [];
  // tabular rows unitize as response|sentence; document/transcript sources
  // confirm with the server's format default (omit the scheme)
  let unitization = tabular ? "response" : null;
  // identifier handling at confirm — scan is the default for every source
  let piiMode = "scan";

  // THE choice of an import: which column is the unit text. Mean length comes
  // from the parser's stats when present, else from the preview rows; the
  // default is the LONGEST text-role column (never just the first).
  const meanLenOf = (col) => col.stats?.meanLength
    ?? Math.round(preview.reduce((s, row) => s + String(row?.[col.name] ?? "").length, 0) / Math.max(1, preview.length));
  const previewLineOf = (name) => {
    for (const row of preview) {
      const v = String(row?.[name] ?? "").trim();
      if (v) return v.length > 90 ? v.slice(0, 90) + "…" : v;
    }
    return "";
  };
  const ranked = columns
    .map((col) => ({ col, meanLen: meanLenOf(col), preview: previewLineOf(col.name) }))
    .sort((a, b) => b.meanLen - a.meanLen);
  const textRanked = ranked.filter((r) => r.col.role === "text");
  let unitTextColumn = (textRanked[0] ?? ranked[0])?.col.name ?? null;

  mount.append(screenHead({
    overline: "Import · review the mapping",
    title: file?.name ?? "Mapping",
    lede: `Parsed locally — ${fmtCount(preview.length)} preview rows below. Adjust any column's role; nothing here blocks the import.`,
  }));

  /* -- unit text: the one choice that decides what gets measured -- */
  const confirmLabel = () => (tabular && unitTextColumn ? `Import — unit text from ${unitTextColumn}` : "Confirm import");
  if (tabular) {
    const choiceRow = (r) => el("label", { class: "choice" },
      el("input", {
        type: "radio", name: "unit-text", value: r.col.name,
        checked: r.col.name === unitTextColumn,
        onchange: () => {
          unitTextColumn = r.col.name;
          confirmBtn.textContent = confirmLabel();
        },
      }),
      el("span", { class: "choice__text" },
        el("span", { class: "choice__label" },
          el("span", { class: "data" }, r.col.name),
          el("span", { class: "chip chip--ghost data" }, `~${fmtCount(r.meanLen)} chars`),
          r === textRanked[0] ? el("span", { class: "chip chip--ghost choice__advised" }, "longest text column") : null),
        r.preview ? el("span", { class: "choice__preview data" }, r.preview) : null));

    const others = ranked.filter((r) => r.col.role !== "text");
    mount.append(section("Unit text — the column Concord measures",
      el("p", { class: "screen__hint" },
        "One column becomes the text of every unit; every other column rides along as metadata. ",
        "Concord pre-picked the longest text column — check the preview line and change it if that is not the answer text."),
      el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Unit text column" } },
        ...textRanked.map(choiceRow),
        textRanked.length === 0
          ? el("p", { class: "screen__hint faint" }, "No column was detected as text — pick one below.")
          : null,
        others.length
          ? el("details", { class: "utc-more", open: textRanked.length === 0 },
              el("summary", {}, `Pick from all ${fmtCount(columns.length)} columns…`),
              el("div", { class: "choicelist utc-more__list" }, ...others.map(choiceRow)))
          : null)));
  }

  /* -- column role chips -- */
  if (tabular) {
    const colList = el("div", { class: "colchips" },
      ...columns.map((col) => columnChip(col)),
    );
    mount.append(section("Detected columns", colList));
  }

  /* -- 20-row preview -- */
  const previewCols = tabular
    ? columns.map((c) => ({ key: c.name, label: c.name, sortable: false, numeric: c.role === "numeric" }))
    : Object.keys(proposal.preview?.[0] ?? {}).map((k) => ({ key: k, label: k, sortable: false }));
  mount.append(section("Preview · first 20 rows",
    table.render({
      caption: "Import preview",
      columns: previewCols,
      rows: proposal.preview ?? [],
      dense: true,
      empty: { title: "No preview rows.", hint: "The parser returned no data — check the file." },
    }),
  ));

  /* -- issues as annotations, not blockers -- */
  if (proposal.issues?.length) {
    mount.append(section("Noted, not blocking",
      el("ul", { class: "issuelist", role: "list" },
        ...proposal.issues.map((issue) =>
          el("li", { class: "issue" },
            el("span", { class: "chip chip--signal issue__kind" },
              `${issue.kind ?? "issue"}${issue.count !== undefined ? ` · ${fmtCount(issue.count)}` : ""}`),
            el("span", { class: "issue__note" }, issue.note ?? issue.message ?? ""),
          ))),
    ));
  }

  /* -- unitization (tabular sources choose; documents take the format default) -- */
  if (tabular) {
    const options = [
      { scheme: "response", label: "Response", hint: "one unit per row — the natural unit for survey open-ends" },
      { scheme: "sentence", label: "Sentence", hint: "splits each row on sentence bounds — finer grain, more units" },
    ];
    mount.append(section("Unit of analysis",
      el("p", { class: "screen__hint" }, "Choose what one measured unit is. Junk and duplicates are scanned at confirm and import flagged, never dropped."),
      el("div", { class: "choicelist choicelist--row", role: "radiogroup", aria: { label: "Unitization scheme" } },
        ...options.map((opt) =>
          el("label", { class: "choice choice--card" },
            el("input", {
              type: "radio", name: "unitization", value: opt.scheme,
              checked: opt.scheme === unitization,
              onchange: () => { unitization = opt.scheme; },
            }),
            el("span", { class: "choice__text" },
              el("span", { class: "choice__label" },
                opt.label,
                opt.scheme === "response" ? el("span", { class: "chip chip--ghost choice__advised" }, "advised") : null),
              el("span", { class: "choice__hint" }, opt.hint)),
          ))),
    ));
  }

  /* -- identifiers: scan (default) / pseudonymize / off -- */
  const piiOptions = [
    {
      mode: "scan",
      label: "Scan only (default)",
      hint: "Counts identifiers and flags the units. Text is unchanged.",
    },
    {
      mode: "pseudonymize",
      label: "Pseudonymize",
      hint: "Replaces identifiers before any model call: jane.doe@example.com becomes [EMAIL_1]. Originals stay in a local vault file that never leaves this machine and is excluded from exports.",
    },
    {
      mode: "off",
      label: "Off",
      hint: "No identifier scan.",
    },
  ];
  mount.append(section("Identifiers (emails, phones, names)",
    el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Identifier handling" } },
      ...piiOptions.map((opt) =>
        el("label", { class: "choice" },
          el("input", {
            type: "radio", name: "pii-mode", value: opt.mode,
            checked: opt.mode === piiMode,
            onchange: () => { piiMode = opt.mode; },
          }),
          el("span", { class: "choice__text" },
            el("span", { class: "choice__label" }, opt.label),
            el("span", { class: "choice__hint" }, opt.hint)),
        ))),
  ));

  /* -- the one confirm — it echoes the unit-text choice -- */
  const confirmBtn = el("button", {
    class: "btn btn--primary btn--lg",
    type: "button",
    onclick: async () => {
      confirmBtn.disabled = true;
      const progress = progressRule("Unitizing…");
      bar.replaceChildren(progress.el);
      // read BEFORE the refresh below — was this an additional corpus?
      const hadCorpora = (store.get("project")?.corpora?.length ?? 0) > 0;
      try {
        // live confirm wants the text column by name + the scheme + the pii mode
        const textColumn = tabular ? unitTextColumn : null;
        const result = await confirmImport(params.slug, {
          importId: proposal.importId,
          mapping: textColumn ? { textColumn } : {},
          unitization: unitization ? { scheme: unitization } : {},
          pii: piiMode,
        });
        progress.finish();
        const junkCounts = result.junkQueue?.counts ?? {};
        const junkTotal = Object.values(junkCounts).reduce((s, n) => s + n, 0);
        const piiLine = piiSummary(result.pii);
        toast.success(`Corpus imported — ${fmtCount(result.unitCount)} units${textColumn ? ` from “${textColumn}”` : ""}.`, {
          detail: `${fmtCount(junkTotal)} flagged as junk (kept, marked)${unitization ? ` · ${unitization} unitization` : ""}`
            + (piiLine ? ` · ${piiLine}` : "")
            + (hadCorpora ? " · Existing instruments can run on this corpus from Runs → New run." : ""),
          data: true,
        });
        await refreshProject(params.slug).catch(() => {});
        router.navigate(`p/${params.slug}/corpus/${result.corpusId}/instant`);
      } catch (err) {
        confirmBtn.disabled = false;
        bar.replaceChildren(confirmBtn);
        toast.error("Import failed.", { detail: String(err.message ?? err) });
      }
    },
  }, confirmLabel());
  const bar = el("div", { class: "confirmbar" }, confirmBtn);
  mount.append(bar);
}

// POST import/confirm with the FULL body. The api.imports.confirm wrapper
// forwards only {mapping, unitization} and would silently drop the pii choice
// (it already drops importId — the server's latest-upload fallback exists for
// that reason); api.js is frozen for this change, so the screen speaks the
// same JSON envelope itself. Fixtures mode patches api.imports.confirm in
// place, so the demo routes through the wrapper as before.
async function confirmImport(slug, body) {
  if (fixturesEnabled()) return api.imports.confirm(slug, body);
  let res;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(slug)}/import/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError("UNREACHABLE", `Concord server unreachable (${err.message})`, { status: 0 });
  }
  let envelope = null;
  try { envelope = JSON.parse(await res.text()); } catch { /* non-JSON body */ }
  if (envelope?.ok === true) return envelope.data;
  if (envelope?.ok === false && envelope.error) {
    throw new ApiError(envelope.error.code || "ERROR", envelope.error.message || "Request failed", {
      status: res.status, details: envelope.error,
    });
  }
  throw new ApiError("HTTP_" + res.status, `POST import/confirm → ${res.status}`, { status: res.status });
}

// One sentence of what the identifier step found, zeros skipped — null when
// the scan was off or found nothing.
//   scan:         "Identifiers found: 14 emails, 3 phone numbers"
//   pseudonymize: "Identifiers replaced: 14 emails, 3 phone numbers — vault saved locally."
const PII_NOUNS = {
  email: ["email", "emails"],
  phone: ["phone number", "phone numbers"],
  ssn: ["SSN", "SSNs"],
  url_user: ["URL with credentials", "URLs with credentials"],
  name: ["name", "names"],
};
function piiSummary(pii) {
  if (!pii?.counts) return null;
  const parts = Object.entries(pii.counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${fmtCount(n)} ${(PII_NOUNS[kind] ?? [kind, kind])[n === 1 ? 0 : 1]}`);
  if (parts.length === 0) return null;
  return pii.mode === "pseudonymize"
    ? `Identifiers replaced: ${parts.join(", ")} — vault saved locally.`
    : `Identifiers found: ${parts.join(", ")}`;
}

function columnChip(col) {
  const select = el("select", {
    class: "colchip__role",
    "aria-label": `Role for column ${col.name}`,
    onchange: (e) => { col.role = e.target.value; wrap.dataset.role = col.role; },
  },
    ...ROLES.map((r) => el("option", { value: r, selected: r === col.role }, r)),
  );
  const statBits = [];
  const s = col.stats ?? {};
  if (s.distinct !== undefined) statBits.push(`${fmtCount(s.distinct)} distinct`);
  if (s.meanLength !== undefined) statBits.push(`~${fmtCount(s.meanLength)} chars`);
  if (s.min !== undefined && s.max !== undefined) statBits.push(`${s.min}–${s.max}`);
  if (s.parseRate !== undefined) statBits.push(`${fmtPct(s.parseRate, 1)} parse`);

  const wrap = el("div", { class: "colchip", dataset: { role: col.role } },
    el("div", { class: "colchip__head" },
      el("span", { class: "colchip__name data" }, col.name),
      el("span", { class: "colchip__conf", title: "Detection confidence" },
        el("span", { class: "colchip__confbar", style: { "--conf": `${Math.round((col.confidence ?? 0) * 100)}%` }, aria: { hidden: "true" } }),
        el("span", { class: "data faint" }, fmtPct(col.confidence ?? 0, 0))),
    ),
    select,
    statBits.length ? el("p", { class: "colchip__stats faint data" }, statBits.join(" · ")) : null,
  );
  return wrap;
}

function progressRule(label) {
  const fill = el("span", { class: "progressrule__fill", style: { width: "8%" } });
  const node = el("div", { class: "progressrule", role: "status", aria: { label } },
    el("span", { class: "progressrule__track", aria: { hidden: "true" } }, fill),
    el("span", { class: "progressrule__label" }, label),
  );
  let pct = 8;
  const timer = setInterval(() => {
    pct = Math.min(92, pct + 6 + Math.random() * 10);
    fill.style.width = pct + "%";
  }, 180);
  return {
    el: node,
    finish() {
      clearInterval(timer);
      fill.style.width = "100%";
    },
  };
}
