// Reliability: the pairwise agreement matrix over every comparable label
// SOURCE for a construct on a corpus — model vs model, model vs human gold,
// human vs human — so rater reliability is readable in one place.
//
// Sources (per the contract):
//   inst:<instrumentId>  each instrument measuring the construct with a
//                        complete (or partial ≥30-unit) run on the corpus,
//                        read from its LATEST such run's final labels (the
//                        aggregate line for panels; flagged/no-label lines
//                        are missing data, never forced verdicts);
//   gold                 the adjudicated-or-consensus gold labels across the
//                        construct's gold-tier sets on this corpus (the
//                        single assembly point goldLabelMap — excluded units
//                        are skipped there);
//   coder:<coderId>      each human coder with ≥10 labels in those gold sets
//                        (uncodable marks are absent rows by construction —
//                        they live outside coders[].labels);
//   retest:<id>:<k>      one source per stability-check rerun, read from the
//                        per-rerun artifact the instruments route persists at
//                        projects/<slug>/stability/<instrumentId>.json (one
//                        per instrument, newest check wins) — only when the
//                        artifact's corpus is THIS corpus; a check on a
//                        different corpus yields a note instead of sources;
//   alt:<id>:<provider>/<model>
//                        one source per successful alternate judge in that
//                        same artifact (the stability check ran the model
//                        over the same sample with the instrument's compiled
//                        prompt) — same corpus rule as retest rows; an
//                        errored alternate becomes a functional note.
// Staleness: when the artifact's versionHash differs from the instrument's
// CURRENT versionHash (the instrument was edited after the check), retest and
// alt labels gain " (earlier version)" and one note says to rerun the check;
// artifacts without the field are treated as current (back-compat).
//
// Pairs: every source combination. Overlap n ≥ 10 → percent always, κ/α via
// stats/agreement (through agreementReport, which passes the construct's
// declared category order into order-sensitive statistics and yields null —
// never a crash — on degenerate distributions). Overlap < 10 → the pair is
// listed with null statistics and a note.
//
// PURE READ: no ledger writes, no model calls, no project mutation. Each
// candidate run's outputs stream once; everything joins in memory.
import {
  findOr404, loadProject, readGoldset, goldLabelMap, statValue,
  agreementReport, readNdjson, runOutputsFile, readJsonFile,
} from "./_shared.js";
import { stabilityFile } from "./instruments.js";
import { finalJurorOfRun } from "../runs/engine.js";

const MIN_OVERLAP = 10;      // below this, pair statistics are withheld (null)
const MIN_PARTIAL_RUN = 30;  // a non-complete run must cover ≥ this many units
const MIN_CODER_LABELS = 10; // a coder qualifies as a source at this many labels

// Newest-first candidates → the latest usable run: complete (with at least
// one usable final label) or partial covering ≥ MIN_PARTIAL_RUN units.
// Returns {run, labels: Map(unitId → statValue(label))} or null.
async function latestSourceRun(slug, instrument, runs) {
  for (const run of runs) {
    // keyed per run on the hash it RAN under — an unfrozen instrument edited
    // after the run must not blank its reliability source
    const fin = finalJurorOfRun(run, instrument);
    const outputs = await readNdjson(runOutputsFile(slug, run.id), {
      filter: (o) => o.juror === fin,
    }).catch(() => []);
    const labels = new Map();
    for (const o of outputs) {
      if (o.label === undefined || o.flagged) continue; // missing data, not a verdict
      labels.set(o.unitId, statValue(o.label));
    }
    if (labels.size === 0) continue;
    if (run.status === "complete" || labels.size >= MIN_PARTIAL_RUN) return { run, labels };
  }
  return null;
}

// Default corpus when ?corpusId= is absent: the corpus of the construct's
// most recent run, else of its first gold-tier set, else the project's first.
function defaultCorpusId(project, construct) {
  const instIds = new Set(
    (project.instruments ?? []).filter((i) => i.constructId === construct.id).map((i) => i.id),
  );
  const latestRun = (project.runs ?? [])
    .filter((r) => instIds.has(r.instrumentId) && r.startedAt)
    .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")))[0];
  if (latestRun) return latestRun.corpusId;
  const gs = (project.goldsets ?? []).find(
    (g) => g.constructId === construct.id && (g.tier ?? "gold") === "gold" && g.corpusId,
  );
  return gs?.corpusId ?? project.corpora?.[0]?.id ?? null;
}

export default [
  {
    method: "GET",
    pattern: "/api/projects/:p/reliability/:constructId",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const construct = findOr404(project.constructs, params.constructId, "construct");
      let corpusId = req.query.corpusId || null;
      if (corpusId) findOr404(project.corpora, corpusId, "corpus");
      else corpusId = defaultCorpusId(project, construct);

      const notes = [];
      const sources = []; // {key, label, kind, n, runId?, level?, labels: Map}
      let retestAvailable = false;

      if (corpusId) {
        // ---- instrument sources: latest complete/partial run per instrument
        for (const inst of (project.instruments ?? []).filter((i) => i.constructId === construct.id)) {
          const runs = (project.runs ?? [])
            .filter((r) => r.instrumentId === inst.id && r.corpusId === corpusId && r.startedAt)
            .sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
          const hit = await latestSourceRun(project.slug, inst, runs);
          if (!hit) continue;
          if (hit.run.status !== "complete") {
            notes.push(`inst:${inst.id} reads a partial run (${hit.labels.size} units, status ${hit.run.status})`);
          }
          sources.push({
            key: `inst:${inst.id}`,
            label: inst.name ?? inst.id,
            kind: "instrument",
            n: hit.labels.size,
            runId: hit.run.id,
            level: inst.level,
            labels: hit.labels,
          });
        }

        // ---- gold + coder sources from the construct's gold-tier sets on
        // this corpus (silver sets are Director labels — never human gold)
        const goldLabels = new Map();
        const coderLabels = new Map(); // coderId → Map(unitId → value)
        const metas = (project.goldsets ?? []).filter(
          (g) => g.constructId === construct.id && (g.tier ?? "gold") === "gold" && g.corpusId === corpusId,
        );
        for (const meta of metas) {
          const gs = await readGoldset(project.slug, meta.id).catch(() => null);
          if (!gs) continue;
          for (const [unitId, label] of goldLabelMap(gs)) {
            if (!goldLabels.has(unitId)) goldLabels.set(unitId, statValue(label));
          }
          for (const c of gs.coders ?? []) {
            const entries = Object.entries(c.labels ?? {});
            if (entries.length === 0) continue;
            let m = coderLabels.get(c.coderId);
            if (!m) coderLabels.set(c.coderId, (m = new Map()));
            for (const [unitId, label] of entries) {
              if (!m.has(unitId)) m.set(unitId, statValue(label));
            }
          }
        }
        if (goldLabels.size > 0) {
          // gold = adjudicated, or ≥2 coders unanimous with no conflicting
          // verdict (goldLabelMap is the single assembly point for that rule)
          sources.push({ key: "gold", label: "Gold — adjudicated or ≥2 coders unanimous", kind: "gold", n: goldLabels.size, labels: goldLabels });
        }
        for (const [coderId, m] of [...coderLabels.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          if (m.size < MIN_CODER_LABELS) continue;
          sources.push({ key: `coder:${coderId}`, label: coderId, kind: "coder", n: m.size, labels: m });
        }

        // ---- test–retest sources: the per-rerun artifact the stability
        // route persists (one per instrument, newest check wins). Reruns on
        // THIS corpus become ordinary sources and ride the same pairwise
        // loop; a check on a different corpus gets a note, never sources.
        for (const inst of (project.instruments ?? []).filter((i) => i.constructId === construct.id)) {
          const artifact = await readJsonFile(stabilityFile(project.slug, inst.id)).catch(() => null);
          if (!artifact) continue;
          if (artifact.corpusId !== corpusId) {
            notes.push(`A stability check exists for ${inst.name ?? inst.id} on a different corpus. Run the stability check on this corpus to see rerun rows.`);
            continue;
          }
          // The artifact records the versionHash its reruns actually ran
          // (the compiled prompt at check time). When the instrument has been
          // edited since, the rows still show — marked, with one note — so
          // old reruns are never silently attributed to the current prompt.
          // Artifacts predating the field are treated as current (no false
          // alarms on old projects).
          const stale = artifact.versionHash !== undefined && artifact.versionHash !== inst.versionHash;
          const versionTag = stale ? " (earlier version)" : "";
          if (stale) {
            notes.push(`The stability check for ${inst.name ?? inst.id} ran on an earlier version of the instrument — rerun it to refresh.`);
          }
          for (const rerun of artifact.reruns ?? []) {
            const labels = new Map();
            for (const [unitId, label] of Object.entries(rerun.labels ?? {})) {
              labels.set(unitId, statValue(label));
            }
            sources.push({
              key: `retest:${inst.id}:${rerun.index}`,
              label: `${inst.name ?? inst.id} — rerun ${rerun.index} of ${artifact.k}${versionTag}`,
              kind: "retest",
              n: labels.size,
              labels,
            });
            retestAvailable = true;
          }
          // alternate judges from the same check: one ordinary source per
          // successful alternate (the generic loop below yields alt-vs-alt,
          // alt-vs-retest, alt-vs-inst, alt-vs-coder and alt-vs-gold pairs);
          // an errored alternate is a note, never a source.
          for (const alt of artifact.alts ?? []) {
            if (alt.error !== undefined) {
              notes.push(`Alternate judge ${alt.model} failed during the stability check: ${alt.error}.`);
              continue;
            }
            const labels = new Map();
            for (const [unitId, label] of Object.entries(alt.labels ?? {})) {
              labels.set(unitId, statValue(label));
            }
            sources.push({
              key: `alt:${inst.id}:${alt.provider}/${alt.model}`,
              label: `${inst.name ?? inst.id} — alt judge ${alt.model}${versionTag}`,
              kind: "alt",
              n: labels.size,
              labels,
            });
          }
        }
      } else {
        notes.push("this project has no corpus yet — import data to populate the matrix");
      }

      if (sources.length < 2) {
        notes.push("fewer than two comparable label sources on this corpus — run instruments, complete a gold set, or add coders");
      }

      // ---- every source combination, joined on unitId
      const pairs = [];
      for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
          const A = sources[i];
          const B = sources[j];
          const rows = [];
          let n = 0;
          for (const [unitId, va] of A.labels) {
            const vb = B.labels.get(unitId);
            if (vb === undefined) continue;
            n++;
            rows.push({ unitId, coder: A.key, value: va }, { unitId, coder: B.key, value: vb });
          }
          if (n < MIN_OVERLAP) {
            pairs.push({ a: A.key, b: B.key, n, percent: null, kappa: null, alpha: null });
            notes.push(`${A.key} × ${B.key}: only ${n} overlapping unit${n === 1 ? "" : "s"} (need ≥ ${MIN_OVERLAP}) — statistics withheld`);
            continue;
          }
          const rep = agreementReport(rows, construct);
          pairs.push({ a: A.key, b: B.key, n, percent: rep.percent, kappa: rep.kappa, alpha: rep.alpha });
        }
      }

      return {
        constructId: construct.id,
        corpusId,
        sources: sources.map(({ labels, ...s }) => s),
        pairs,
        notes,
        retestAvailable,
      };
    },
  },
];
