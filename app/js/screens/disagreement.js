// Disagreement — #/p/:slug/runs/:rid/disagreement — where the panel splits,
// reading begins. Entropy-ranked unit list (entropy bar + label chips), the
// juror×juror agreement matrix as heat, side-by-side facing-column rationales
// in machine blue with juror names in mono, and two dispositions per unit:
// route to the human queue (goldset) or treat as a codebook defect (construct
// editor opens with a prefilled edge-case note). Panel disagreement where
// humans agreed = instrument problem; where humans also split = construct
// ambiguity. Different reads, different fixes.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as heat from "../components/charts/heat.js";
import * as quotecard from "../components/quotecard.js";
import { fmtStat } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, emptyState } from "./_shared.js";

export const route = "p/:slug/runs/:rid/disagreement";
export const title = "Disagreement";

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const data = await api.runs.disagreement(params.slug, params.rid);
    return { project, data };
  }, ({ project, data }) => {
    mount.append(screenHead({
      overline: `Run · ${params.rid}`,
      title: "Units the panel disagreed on.",
      lede: "Units the panel could not agree on, ranked by how evenly the votes split. For each one: send it to the human gold queue, or treat it as a codebook defect and tighten the construct.",
    }));

    if (!data?.byEntropy?.length) {
      mount.append(emptyState({
        title: "No disagreements found.",
        body: data?.note ?? "No units cleared the entropy threshold. This can happen when the corpus is unambiguous or the jurors are too similar. Check the family chips on the panel.",
      }));
      return;
    }

    /* -- juror×juror matrix: jurorMatrix = {jurors, matrix} -- */
    const jurors = data.jurorMatrix?.jurors ?? [];
    const matrix = data.jurorMatrix?.matrix ?? [];
    const matrixCell = el("div", { class: "jurmatrix" });
    heat.render(matrixCell, {
      rows: jurors,
      cols: jurors,
      values: matrix,
    }, {
      caption: "Pairwise raw agreement between jurors. Low cells indicate a juror that agrees least with the others.",
      format: (v) => fmtStat(v),
    });
    mount.append(section("Juror × juror agreement", matrixCell));

    // live: item.labels = {juror → label} (per-juror confidence/rationale
    // live in the evidence dossier, one click away)
    const readsOf = (item) =>
      Object.entries(item.labels ?? {}).map(([juror, label]) => ({ juror, label }));

    /* -- entropy-ranked list + facing rationales -- */
    const listEl = el("div", { class: "split disagreement-split" });
    const queue = el("nav", { class: "split__list", aria: { label: "Disagreements by entropy" } });
    const detail = el("div", { class: "split__main" });
    listEl.append(queue, detail);
    mount.append(section("Disagreements, ranked by entropy", listEl));

    let activeBtn = null;
    for (const item of data.byEntropy) {
      const labels = readsOf(item);
      const btn = el("button", {
        class: "listitem listitem--btn", type: "button",
        onclick: () => {
          activeBtn?.classList.remove("listitem--active");
          activeBtn = btn;
          btn.classList.add("listitem--active");
          drawDetail(item);
        },
      },
        el("span", { class: "listitem__name data" }, item.unitId),
        el("span", { class: "entropy" },
          el("span", { class: "entropy__track", aria: { hidden: "true" } },
            el("span", { class: "entropy__fill", style: { width: `${Math.round(item.entropy * 100)}%` } })),
          el("span", { class: "chip chip--signal data" }, `H ${fmtStat(item.entropy)}`)),
        el("span", { class: "listitem__meta" },
          ...labels.slice(0, 3).map((l) => el("span", { class: "chip chip--machine" }, l.label))),
      );
      queue.append(btn);
    }

    function drawDetail(item) {
      clear(detail);
      const labels = readsOf(item);

      // the facing columns enrich from the evidence dossier: this run's
      // per-juror lines carry confidence + rationale (the disagreement route
      // itself returns only the label map)
      const quoteHost = el("div", {});
      const facing = el("div", { class: "facing facing--n", style: { "--cols": String(Math.min(labels.length, 3)) } });
      const judgeCol = (l, line) =>
        el("div", { class: "dossier__judge" },
          el("div", { class: "dossier__judge-head" },
            el("span", { class: "chip chip--machine" }, String(l.label)),
            el("span", { class: "dossier__judge-name data" }, String(l.juror).slice(0, 12)),
            line?.confidence !== undefined
              ? el("span", { class: "dossier__judge-conf data" }, "conf ", fmtStat(line.confidence),
                  el("span", { class: "confbar", aria: { hidden: "true" }, style: { "--conf": `${Math.round(line.confidence * 100)}%` } }))
              : null),
          line?.rationale ? el("p", { class: "dossier__rationale" }, line.rationale) : null);
      facing.append(...labels.map((l) => judgeCol(l, null)));

      api.evidence.get(params.slug, item.unitId)
        .then((dossier) => {
          quoteHost.append(quotecard.render({ unit: dossier.unit, evidence: true }));
          const runOutputs = (dossier.outputs ?? []).find((o) => o.runId === params.rid)?.outputs ?? [];
          facing.replaceChildren(...labels.map((l) =>
            judgeCol(l, runOutputs.find((o) => o.juror === l.juror))));
        })
        .catch(() => quoteHost.append(el("p", { class: "data faint" }, item.unitId)));

      detail.append(
        quoteHost,
        facing,
        el("div", { class: "dispositions" },
          el("button", {
            class: "btn", type: "button",
            onclick: () => routeToHuman(item),
          }, "Route to human queue"),
          el("button", {
            class: "btn", type: "button",
            onclick: () => codebookDefect(item),
          }, "Treat as codebook defect")),
      );
    }

    async function routeToHuman(item) {
      // POST goldsets/:g/queue — the unit joins the sample as {pi: null,
      // queued: true}: codable and adjudicable, read by agreement, never a
      // π-weighted DSL gold row. Idempotent per unit.
      try {
        const goldsets = await api.goldsets.list(params.slug);
        const g = goldsets[0];
        if (!g) {
          toast.warn("No gold set exists yet.", { detail: "create one in the Calibration Studio first" });
          return;
        }
        const res = await api.goldsets.queue(params.slug, g.id, { unitId: item.unitId });
        if (res?.already) {
          toast.info("Already in the human queue.", { detail: item.unitId, data: true });
        } else {
          toast.success("Routed to the human queue.", { detail: `${item.unitId} → ${g.name ?? g.id} (queued with π = null — never a corrected-estimate row)`, data: true });
        }
      } catch (err) {
        toast.error("Routing failed.", { detail: String(err.message ?? err) });
      }
    }

    async function codebookDefect(item) {
      try {
        const constructs = await api.constructs.list(params.slug);
        const k = constructs[0];
        if (!k) {
          toast.warn("No construct to amend.");
          return;
        }
        toast.info("Opening the construct with a prefilled edge-case note…", { duration: 2200 });
        router.navigate(`p/${params.slug}/constructs/${k.id}?edgecase=${encodeURIComponent(item.unitId)}`);
      } catch (err) {
        toast.error("Could not open the construct.", { detail: String(err.message ?? err) });
      }
    }

    // open the highest-entropy unit by default
    queue.querySelector("button")?.click();
  }, "Ranking the splits…");
}
