// Projects home — #/ — the shelf of studies. Each card: name, corpus count,
// ladder summary (how much of the work has earned which mark), privacy chip.
// The new-project sheet asks only what cannot be defaulted: a name and a
// privacy mode, stated in plain language.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import { fmtCount, fmtDate } from "../format.js";
import { screenHead, emptyState, asyncMount, openSheet, ensureProject } from "./_shared.js";

export const route = "";
export const title = "Projects";

const PRIVACY = [
  { value: "open", label: "Open", hint: "Any configured model backend may read this corpus." },
  { value: "no-training", label: "No-training", hint: "Only backends with contractual no-training terms (plus local models). Overrides are logged." },
  { value: "strict", label: "Strict · local only", hint: "Network adapters are disabled app-wide. The Director must be a local model." },
];

export function render(mount) {
  asyncMount(mount, () => api.projects.list(), (projects) => {
    mount.append(
      screenHead({
        overline: "Concord",
        title: "Projects",
        lede: "Each project is a portable folder containing its corpus, codebook, instruments, gold, and ledger. Copy the folder to copy the whole study.",
        actions: [
          el("button", { class: "btn btn--primary", type: "button", onclick: () => newProjectSheet() }, "New project"),
        ],
      }),
    );

    if (!projects?.length) {
      mount.append(emptyState({
        mark: "◌ ◑ ● ◉",
        title: "No projects yet.",
        body: "Create a project, then drop in a corpus — survey open-ends, interview transcripts, reviews — and measure it with instruments you can audit.",
        hint: "After creating, drop a file anywhere to import.",
        actions: [el("button", { class: "btn btn--primary", type: "button", onclick: () => newProjectSheet() }, "New project")],
      }));
      return;
    }

    const grid = el("div", { class: "projgrid" });
    for (const p of projects) {
      grid.append(projectCard(p));
    }
    mount.append(grid);

    mount.append(el("p", { class: "screen__footnote faint" },
      "Every number in every project shows its evidence mark — ",
      el("span", { class: "data" }, "◌ ◑ ● ◉"),
      " — and clicking a mark shows the quotes behind that number."));
  }, "Opening the shelf…");
}

// Live summary (GET /api/projects): {id, name, slug, createdAt, privacyMode,
// budget, director, counts: {corpora, constructs, instruments, goldsets,
// runs, analyses, briefs}} — or {slug, corrupt: true} for unreadable bundles.
function projectCard(p) {
  if (p.corrupt) {
    return el("div", { class: "projcard projcard--corrupt" },
      el("h3", { class: "projcard__name" }, p.slug),
      el("p", { class: "faint" }, "This bundle did not load — its project.json is unreadable."));
  }
  const counts = p.counts ?? {};
  const workRow = el("p", { class: "projcard__ladder data faint" },
    (counts.instruments || counts.analyses)
      ? `${fmtCount(counts.constructs ?? 0)} constructs · ${fmtCount(counts.instruments ?? 0)} instruments · ${fmtCount(counts.analyses ?? 0)} analyses`
      : "nothing measured yet");

  return el("a", { class: "projcard", href: `#/p/${encodeURIComponent(p.slug)}` },
    el("h3", { class: "projcard__name" }, p.name),
    el("p", { class: "projcard__meta data" },
      `${fmtCount(counts.corpora ?? 0)} ${counts.corpora === 1 ? "corpus" : "corpora"}`,
      counts.runs ? ` · ${fmtCount(counts.runs)} runs` : "",
      counts.goldsets ? ` · ${fmtCount(counts.goldsets)} gold` : "",
    ),
    workRow,
    el("p", { class: "projcard__foot" },
      el("span", { class: "chip" }, p.privacyMode ?? "open"),
      p.createdAt ? el("span", { class: "faint projcard__date" }, fmtDate(p.createdAt)) : null,
    ),
  );
}

function newProjectSheet() {
  const name = el("input", { class: "input", type: "text", placeholder: "e.g. TechCorp Exit Survey", "aria-label": "Project name" });
  let privacy = "no-training";

  const radios = el("div", { class: "choicelist", role: "radiogroup", aria: { label: "Privacy mode" } },
    ...PRIVACY.map((opt) =>
      el("label", { class: "choice" },
        el("input", {
          type: "radio", name: "privacy", value: opt.value, checked: opt.value === privacy,
          onchange: () => { privacy = opt.value; },
        }),
        el("span", { class: "choice__text" },
          el("span", { class: "choice__label" }, opt.label),
          el("span", { class: "choice__hint" }, opt.hint)),
      )),
  );

  const s = openSheet({ title: "New project", overline: "Begin" });
  s.body.append(
    el("label", { class: "field" },
      el("span", { class: "field__label overline" }, "Name"),
      name),
    el("div", { class: "field" },
      el("span", { class: "field__label overline" }, "Privacy mode"),
      el("p", { class: "field__hint" }, "Privacy is enforced at the provider layer, not by promise. You can tighten it later; loosening asks for explicit confirmation and is ledgered."),
      radios),
  );
  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        const value = name.value.trim();
        if (!value) { name.focus(); return; }
        e.target.disabled = true;
        try {
          const proj = await api.projects.create({ name: value, privacyMode: privacy });
          toast.success(`Project “${proj.name}” created.`, { detail: proj.slug, data: true });
          s.close();
          router.navigate(`p/${proj.slug}/import`);
        } catch (err) {
          e.target.disabled = false;
          toast.error("Could not create the project.", { detail: String(err.message ?? err) });
        }
      },
    }, "Create project"),
  );
}

/* ---- project landing: #/p/:slug — route to where the work is ----------------- */

export function renderProject(mount, params) {
  clear(mount);
  ensureProject(params.slug)
    .then((project) => {
      if (!project.corpora?.length) router.navigate(`p/${params.slug}/import`, { replace: true });
      else router.navigate(`p/${params.slug}/corpus/${project.corpora[0].id}/instant`, { replace: true });
    })
    .catch(() => {
      mount.append(emptyState({
        title: "This project did not open.",
        body: "It may not exist, or the server is not answering.",
        actions: [el("a", { class: "btn", href: "#/" }, "Back to projects")],
      }));
    });
}
