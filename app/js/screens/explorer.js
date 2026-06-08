// Explorer — #/p/:slug/explore/:runId — what a run found, before anyone
// claims anything. Theme prevalence bars wearing ◌, χ²-ranked metadata
// cross-tabs with honest margin annotations, a co-occurrence heat surface,
// and the quiet calibration nudge in the footer with its honest price.
// Every bar and cell is an evidence door.
//
// Contract (the descriptive analysis computed over the run — POST analyses
// {kind: "descriptive", spec: {runId}} → results):
//   prevalence:       [{label, count, share}]
//   crosstabs:        [{by, table, flaggedNote?}] — table is the stats-layer
//                     crosstab {rows, cols, matrix, rowTotals, colTotals, …}
//   cooccurrence:     {labels, matrix} (only multilabel/panel-flagged runs)
//   calibrationNudge: {constructName, estUnits, estMinutes}
// Evidence doors come from the analysis's evidence.cells (label → unit ids);
// fixture entries may carry per-item evidence arrays directly.

import { el } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as bar from "../components/charts/bar.js";
import * as heat from "../components/charts/heat.js";
import * as smallmultiples from "../components/charts/smallmultiples.js";
import { contextLine, corpusText } from "../components/contextline.js";
import { fmtStat, fmtCount, fmtPct } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, annotation, levelUpNudge, emptyState, runDisplayName } from "./_shared.js";

export const route = "p/:slug/explore/:runId";
export const title = "Explorer";

export function render(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const analysis = await api.analyses.create(params.slug, { kind: "descriptive", spec: { runId: params.runId } });
    return { project, analysis };
  }, ({ project, analysis }) => {
    const explore = analysis?.results ?? analysis ?? {};
    const cells = analysis?.evidence?.cells ?? {};
    if (!explore?.prevalence?.length) {
      mount.append(emptyState({
        title: "Nothing to explore yet.",
        body: "This run has produced no aggregable labels. If it is still running, watch the monitor.",
        actions: [el("a", { class: "btn", href: `#/p/${params.slug}/runs/${params.runId}` }, "Open the run monitor")],
      }));
      return;
    }
    const level = analysis?.level ?? explore.level ?? "exploratory";
    const doorsFor = (label, own) => {
      const ids = own?.length ? own : cells[label];
      return ids?.length ? ids : undefined;
    };

    mount.append(screenHead({
      overline: `Explorer · ${params.runId}`,
      title: "What the run found.",
      lede: "Label counts, metadata splits, and co-occurrence from this run. Click any bar to read the units behind it; the numbers stay exploratory (◌) until the instrument is calibrated against human-coded gold.",
      actions: [
        el("button", {
          class: "btn", type: "button",
          title: "Your rows, plus the instrument's columns: label, confidence, escalated.",
          onclick: () => api.runs.exportCsv(params.slug, params.runId),
        }, "Download labeled CSV"),
      ],
    }));

    /* -- context: which run these findings read, over which corpus/column -- */
    const run = (project?.runs ?? []).find((r) => r.id === params.runId) ?? null;
    const scopeCorpusId = analysis?.spec?.corpusId ?? run?.corpusId ?? null;
    const corpusEntry = (project?.corpora ?? []).find((c) => c.id === scopeCorpusId)
      ?? project?.corpora?.[0] ?? null;
    mount.append(contextLine([
      {
        label: "reading run",
        text: run ? runDisplayName(project, run) : params.runId,
        href: `#/p/${params.slug}/runs/${params.runId}`,
      },
      corpusEntry ? { label: "over", text: corpusText(corpusEntry, project) } : null,
    ]));

    /* -- prevalence: {label, count, share} -- */
    const totalLabels = explore.prevalence.reduce((s, p) => s + (p.count ?? 0), 0);
    const prevCell = el("div", {});
    bar.render(prevCell, explore.prevalence.map((p) => ({
      label: p.label,
      value: p.share,
      level,
      evidence: doorsFor(p.label, p.evidence),
    })), {
      caption: `Theme prevalence — ${fmtCount(totalLabels)} labels across the run. Click a bar to read its units.`,
      format: (v) => fmtPct(v, 1),
      level,
    });
    mount.append(section("Prevalence", prevCell));

    /* -- χ²-ranked metadata cross-tabs: {by, table, flaggedNote?} -- */
    if (explore.crosstabs?.length) {
      const xtWrap = el("div", { class: "xtabs" });
      for (const xt of explore.crosstabs) {
        const t = xt.table ?? {};
        if (!Array.isArray(t.rows) || !Array.isArray(t.cols) || !Array.isArray(t.matrix)) continue;
        const cell = el("div", { class: "xtab" });
        smallmultiples.render(cell, {
          items: t.cols.map((col, j) => ({
            title: String(col),
            data: t.rows.map((row, i) => ({
              label: String(row),
              value: t.colTotals?.[j] ? t.matrix[i][j] / t.colTotals[j] : 0,
              level,
              evidence: doorsFor(String(row)),
            })),
          })),
          renderFn: bar.render,
          sharedDomain: true,
          opts: { format: (v) => fmtPct(v, 0), labelWidth: 76, valueWidth: 52 },
          caption: `label × ${xt.by} — column shares${typeof t.chi2 === "number" ? ` · χ² ${fmtStat(t.chi2)} (df ${t.df})` : ""}`,
        });
        if (xt.flaggedNote) {
          cell.append(annotation({ text: xt.flaggedNote, by: "system" }));
        }
        xtWrap.append(cell);
      }
      if (xtWrap.children.length) {
        mount.append(section("Strongest metadata splits", xtWrap));
      }
    }

    /* -- co-occurrence heat: {labels, matrix} -- */
    const co = explore.cooccurrence;
    if (co?.labels?.length && Array.isArray(co.matrix)) {
      const heatCell = el("div", {});
      heat.render(heatCell, {
        rows: co.labels,
        cols: co.labels,
        values: co.matrix,
        evidence: toEvidenceGrid(co),
      }, {
        caption: "Theme co-occurrence — units carrying both labels. Cells with units are doors.",
        format: (v) => String(v),
      });
      mount.append(section("Co-occurrence", heatCell));
    }

    /* -- the calibration nudge, quiet, priced -- */
    const nudge = explore.calibrationNudge;
    if (nudge) {
      const goldsetId = nudge.goldsetId ?? project?.goldsets?.[0]?.id ?? null;
      mount.append(levelUpNudge({
        construct: nudge.constructName ?? nudge.construct,
        price: nudge.estUnits !== undefined
          ? `~${fmtCount(nudge.estUnits)} units, ~${fmtCount(nudge.estMinutes)} min`
          : nudge.price,
        onGo: () => router.navigate(goldsetId ? `p/${params.slug}/goldsets/${goldsetId}` : `p/${params.slug}`),
      }));
    }

    /* -- the statistics live one screen over — say so, carrying the run -- */
    mount.append(el("p", { class: "screen__hint" },
      el("a", { href: `#/p/${params.slug}/analyses?runId=${encodeURIComponent(params.runId)}` },
        "Analyze in the Workbench →"),
      el("span", { class: "faint" }, " crosstabs, models, triangulation over this run — corrected where gold exists.")));
  }, "Aggregating the run…");
}

/* heat.js expects evidence[r][c] arrays; fixtures may store a sparse "r,c" map */
function toEvidenceGrid(co) {
  if (!co.evidence) return undefined;
  if (Array.isArray(co.evidence)) return co.evidence;
  const k = co.labels.length;
  const grid = Array.from({ length: k }, () => Array.from({ length: k }, () => []));
  for (const [key, ids] of Object.entries(co.evidence)) {
    const [r, c] = key.split(",").map(Number);
    if (grid[r]?.[c]) grid[r][c] = ids;
    if (grid[c]?.[r]) grid[c][r] = ids; // symmetric surface
  }
  return grid;
}
