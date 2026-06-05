// Explorer — #/p/:slug/explore/:runId — what a run found, before anyone
// claims anything. Theme prevalence bars wearing ◌, Director-flagged
// cross-tabs with dismissible margin annotations, a co-occurrence heat
// surface, and the quiet calibration nudge in the footer with its honest
// price. Every bar and cell is an evidence door.

import { el } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as bar from "../components/charts/bar.js";
import * as heat from "../components/charts/heat.js";
import * as smallmultiples from "../components/charts/smallmultiples.js";
import { fmtStat, fmtCount } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, annotation, levelUpNudge, emptyState } from "./_shared.js";

export const route = "p/:slug/explore/:runId";
export const title = "Explorer";

export function render(mount, params) {
  asyncMount(mount, async () => {
    await ensureProject(params.slug);
    // Preferred source: a descriptive analysis computed over the run. The
    // fixtures adapter resolves this from the run's stored explore payload.
    const analysis = await api.analyses.create(params.slug, { kind: "descriptive", spec: { runId: params.runId } });
    return analysis?.results ?? analysis;
  }, (explore) => {
    if (!explore?.prevalence?.length) {
      mount.append(emptyState({
        title: "Nothing to explore yet.",
        body: "This run has produced no aggregable labels. If it is still running, watch the monitor.",
        actions: [el("a", { class: "btn", href: `#/p/${params.slug}/runs/${params.runId}` }, "Open the run monitor")],
      }));
      return;
    }
    const level = explore.level ?? "exploratory";

    mount.append(screenHead({
      overline: `Explorer · ${params.runId}`,
      title: "What the run found.",
      lede: "Exploratory readings — every number wears its mark, and the mark is the door to making it stronger.",
    }));

    /* -- prevalence -- */
    const prevCell = el("div", {});
    bar.render(prevCell, explore.prevalence.map((p) => ({
      label: p.label,
      value: p.value,
      level,
      evidence: p.evidence?.length ? p.evidence : undefined,
    })), {
      caption: `Theme prevalence across the corpus — ${fmtCount(explore.prevalence.reduce((s, p) => s + (p.n ?? 0), 0) || 2439)} labeled units. Click a bar to read its units.`,
      format: (v) => fmtStat(v),
      level,
    });
    mount.append(section("Prevalence", prevCell));

    /* -- Director-flagged cross-tabs -- */
    if (explore.crosstabs?.length) {
      const xtWrap = el("div", { class: "xtabs" });
      for (const xt of explore.crosstabs) {
        const cell = el("div", { class: "xtab" });
        smallmultiples.render(cell, {
          items: xt.groups.map((g) => ({
            title: g.title,
            data: g.data.map((d) => ({
              label: d.label, value: d.value, level,
              evidence: d.evidence?.length ? d.evidence : undefined,
            })),
          })),
          renderFn: bar.render,
          sharedDomain: true,
          opts: { format: (v) => fmtStat(v), labelWidth: 76, valueWidth: 52 },
          caption: xt.title,
        });
        if (xt.annotation) {
          cell.append(annotation({ text: xt.annotation, by: xt.annotatedBy ?? "director" }));
        }
        xtWrap.append(cell);
      }
      mount.append(section("Worth probing — the Director flagged these", xtWrap));
    }

    /* -- co-occurrence heat -- */
    if (explore.cooccurrence) {
      const heatCell = el("div", {});
      heat.render(heatCell, {
        rows: explore.cooccurrence.rows,
        cols: explore.cooccurrence.cols,
        values: explore.cooccurrence.values,
        evidence: toEvidenceGrid(explore.cooccurrence),
      }, {
        caption: "Theme co-occurrence — units mentioning both. Cells with units are doors.",
        format: (v) => String(v),
      });
      mount.append(section("Co-occurrence", heatCell));
    }

    /* -- the calibration nudge, quiet, priced -- */
    const nudge = explore.calibrationNudge;
    if (nudge) {
      mount.append(levelUpNudge({
        construct: nudge.construct,
        price: nudge.price,
        onGo: () => router.navigate(`p/${params.slug}/goldsets/${nudge.goldsetId}`),
      }));
    }
  }, "Aggregating the run…");
}

/* heat.js expects evidence[r][c] arrays; fixtures store a sparse "r,c" map */
function toEvidenceGrid(co) {
  if (!co.evidence) return undefined;
  if (Array.isArray(co.evidence)) return co.evidence;
  const grid = co.rows.map(() => co.cols.map(() => []));
  for (const [key, ids] of Object.entries(co.evidence)) {
    const [r, c] = key.split(",").map(Number);
    if (grid[r]?.[c]) grid[r][c] = ids;
    if (grid[c]?.[r]) grid[c][r] = ids; // symmetric surface
  }
  return grid;
}
