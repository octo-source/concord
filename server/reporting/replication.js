// Replication archive builder. Everything a stranger needs to reproduce every
// corrected statistic OUTSIDE Concord: frozen instruments (full prompts),
// the codebook, gold labels with inclusion probabilities, machine outputs,
// certificate agreement stats, analysis specs/results, and generated R +
// Python scripts that re-derive the DSL-corrected estimates from the CSVs.
//
// Determinism: members are emitted at sorted paths, zip timestamps come from
// the project's createdAt (never "now"), and content is a pure function of the
// bundle — so re-builds hash identically. MANIFEST.json (sha256 of every other
// member) is generated last; the build is then ledgered as export.replication
// with the manifest hash.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { ConcordError } from "../core/errors.js";
import { sha256 } from "../core/ids.js";
import * as ledger from "../core/ledger.js";
import { readNdjson } from "../core/store.js";
import { loadAnalysis, loadGoldset, loadRun } from "./methods.js";

function fail(message, details = {}) {
  throw new ConcordError("VALIDATION", message, details);
}

// ---------------------------------------------------------------------- CSV

// RFC 4180: quote any field containing a quote, comma or line break; double
// embedded quotes. Arrays (multilabel) join with "; ".
//
// Formula-injection hardening: a TEXT cell beginning with =, +, - or @ gets a
// leading apostrophe so spreadsheet apps will not execute it as a formula.
// Numbers and booleans are never prefixed (they must parse numerically in
// R/pandas). The convention is documented in the archive README.
export function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = Array.isArray(v) ? v.join("; ") : String(v);
  if (typeof v !== "number" && typeof v !== "boolean" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

// ------------------------------------------------------------------ helpers

function safeName(name) {
  return String(name ?? "outcome").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "outcome";
}

async function loadUnitsMap(projectDir, corpusIds) {
  const map = new Map();
  for (const id of corpusIds) {
    const units = await readNdjson(path.join(projectDir, "corpora", id, "units.ndjson"));
    for (const u of units) map.set(u.id, { ...u, corpusId: id });
  }
  return map;
}

// Normalize one analysis into what the reproduce scripts need; null when the
// analysis is not a DSL proportion fit the scripts know how to re-derive
// (corrected regressions, PPI fits and cell-less results land in the
// `uncovered` list build() reports honestly instead).
//
// Binarization mode (Concord's cells are DSL proportions of
// indicator(label == positive), via routes/analyses.js dslUnits):
//   "positive" — results.positive was recorded (crosstab/subgroup): every
//                cell binarizes machine + gold labels with that one value;
//   "perCell"  — descriptive corrected analyses record NO positive and
//                groupBy null: each cell's group IS a label value, so each
//                cell binarizes against its own label over ALL units;
//   "numeric"  — legacy archives with groupBy but no recorded positive: the
//                labels are used as numeric 0/1 outcomes, and the script
//                names the fallback.
function dslPlan(analysis, run) {
  const r = analysis.results ?? {};
  const estimator = r.estimator ?? analysis.spec?.estimator ?? "";
  if (analysis.level !== "corrected" || !/^dsl/.test(String(estimator))) return null;
  if (!Array.isArray(r.cells) || r.cells.length === 0) return null;
  const runId = analysis.spec?.runId ?? run?.id;
  const goldsetId = analysis.spec?.goldsetId;
  const corpusId = analysis.spec?.corpusId ?? run?.corpusId;
  if (!runId || !goldsetId || !corpusId) return null;
  const groupBy = r.groupBy ?? analysis.spec?.cols ?? null;
  const positive = r.positive != null ? String(r.positive)
    : analysis.spec?.positive != null ? String(analysis.spec.positive) : null;
  return {
    id: analysis.id,
    outcome: safeName(r.outcome ?? analysis.spec?.rows),
    groupBy,
    mode: positive != null ? "positive" : groupBy == null ? "perCell" : "numeric",
    positive,
    runId,
    goldsetId,
    corpusId,
    cells: r.cells.map((c) => ({ group: String(c.group), est: c.est, se: c.se, ciLo: c.ciLo, ciHi: c.ciHi, naive: c.naive ?? null })),
    diff: r.diff && typeof r.diff.est === "number"
      ? { a: String(r.diff.a), b: String(r.diff.b), est: r.diff.est, se: r.diff.se }
      : null,
  };
}

// ------------------------------------------------------------ member: texts

function readmeMd(project, analyses, includeGoldText, uncovered = []) {
  const lines = [];
  lines.push(`# Replication archive — ${project.name}`);
  lines.push("");
  lines.push("This archive was generated by Concord so that every corrected proportion in the");
  lines.push("study can be reproduced OUTSIDE Concord, from flat files, with public tools.");
  lines.push("It contains the frozen measurement instruments (including full prompt text),");
  lines.push("the codebook, the designed gold sample with inclusion probabilities (pi), the");
  lines.push("machine outputs, all certificate agreement statistics, and the analysis");
  lines.push("specifications with Concord's stored results.");
  lines.push("");
  lines.push("## How to reproduce the corrected estimates");
  lines.push("");
  lines.push("- R: `Rscript reproduce.R` — computes the DSL pseudo-outcome estimator INLINE");
  lines.push("  in base R and ASSERTS near-equality (1e-6) with Concord's stored results via");
  lines.push("  stopifnot. The public `dsl` package (CRAN) is then run as a clearly labeled");
  lines.push("  methodological cross-check: same estimand, different machinery, so it is not");
  lines.push("  expected to match to printed precision and may fail on tiny gold samples.");
  lines.push("- Python: `python reproduce.py` — implements the DSL pseudo-outcome estimator");
  lines.push("  inline (numpy/pandas, no Concord code) and ASSERTS equality with Concord's");
  lines.push("  stored results to 1e-6.");
  lines.push("");
  if (uncovered.length > 0) {
    lines.push("Coverage: proportion cells are script-verified;");
    lines.push("corrected regression refits are not included — see analyses/<id>.json for");
    lines.push("stored estimates (generated refit code is on the roadmap). Not script-covered:");
    for (const u of uncovered) lines.push(`- \`analyses/${u.id}.json\` (estimator ${u.estimator}).`);
    lines.push("");
  }
  lines.push("Panel runs: `outputs/<runId>.csv` then carries a `juror` column with one row");
  lines.push("per juror per unit PLUS one row with juror == \"aggregate\" — the panel's");
  lines.push("aggregated verdict, which is the label Concord analyzes. Both reproduce");
  lines.push("scripts filter to the aggregate rows before merging; do the same in your own");
  lines.push("reanalysis or every unit will be duplicated.");
  lines.push("");
  lines.push("CSV conventions: unit-meta columns are prefixed `meta_` so merges can never");
  lines.push("collide with unitId/label/pi/adjudicated. To block spreadsheet formula");
  lines.push("injection, any TEXT cell beginning with =, +, - or @ carries a leading");
  lines.push("apostrophe (') — strip it when consuming such cells as raw text; numeric");
  lines.push("cells are never prefixed.");
  lines.push("");
  lines.push("## Contents");
  lines.push("");
  // constructs are read live at export — a construct snapshot frozen with the
  // instrument is roadmap, so the README claims exactly the export-time state
  lines.push("- `codebook.md` — the constructs as recorded at export time (construct");
  lines.push("  snapshots at instrument freeze are not yet taken).");
  lines.push("- `instruments/<id>.json` — frozen instrument versions, full payloads and prompts.");
  lines.push("- `dictionaries/<id>.json` — dictionary instruments with complete term lists.");
  lines.push("- `gold/<goldsetId>.csv` — designed sample: unitId, pi, per-coder labels, adjudicated" + (includeGoldText ? ", unit text." : ". Unit text was withheld at export (includeGoldText: false)."));
  lines.push("- `outputs/<runId>.csv` — machine labels: unitId, label, confidence, escalated, cacheHit");
  lines.push("  (+ a `juror` column for panel runs; see the panel note above).");
  lines.push("- `units/<corpusId>.csv` — unit metadata (grouping variables for the analyses; no");
  lines.push("  text). Meta columns carry the `meta_` prefix.");
  lines.push("- `agreement.json` — calibration certificates: machine-vs-gold and human-vs-human agreement.");
  lines.push("- `analyses/<id>.json` — analysis spec, stored results, evidence links, ladder level.");
  lines.push("- `MANIFEST.json` — sha256 of every member (excluding itself); verify before trusting.");
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push(`Project: ${project.name} (id ${project.id}), created ${project.createdAt}.`);
  lines.push(`Analyses included: ${analyses.map((a) => a.id).join(", ")}.`);
  lines.push("Archive timestamps are fixed to the project's creation time so identical");
  lines.push("studies produce byte-identical archives. The export is recorded in the");
  lines.push("project ledger (event type export.replication) with this archive's manifest hash.");
  lines.push("");
  return lines.join("\n");
}

function codebookMd(project) {
  const lines = ["# Codebook", ""];
  for (const c of project.constructs ?? []) {
    lines.push(`## ${c.name} (${c.type})`);
    lines.push("");
    lines.push(c.definition || "(no definition recorded)");
    lines.push("");
    lines.push(`Authored by: ${c.authoredBy}${c.humanTouched ? " (human-reviewed)" : " (not human-reviewed)"}`);
    lines.push("");
    if (c.criteria?.include?.length) {
      lines.push("Include:");
      for (const x of c.criteria.include) lines.push(`- ${x}`);
      lines.push("");
    }
    if (c.criteria?.exclude?.length) {
      lines.push("Exclude:");
      for (const x of c.criteria.exclude) lines.push(`- ${x}`);
      lines.push("");
    }
    if (c.edgeCases?.length) {
      lines.push("Edge cases:");
      for (const x of c.edgeCases) lines.push(`- ${x}`);
      lines.push("");
    }
    if (c.examples?.length) {
      lines.push("Worked examples:");
      for (const ex of c.examples) lines.push(`- [${ex.kind}] label=${csvField(ex.label)} — ${ex.text.replace(/\s+/g, " ")}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function goldCsv(goldset, unitsMap, includeGoldText) {
  const coders = [...(goldset.coders ?? [])].sort((a, b) => (a.coderId < b.coderId ? -1 : 1));
  const header = ["unitId", "pi", ...coders.map((c) => `label_${c.coderId}`), "adjudicated"];
  if (includeGoldText) header.push("text");
  const rows = [header];
  for (const s of goldset.sample ?? []) {
    const row = [s.unitId, s.pi];
    for (const c of coders) row.push(c.labels?.[s.unitId] ?? "");
    row.push(goldset.adjudicated?.[s.unitId] ?? "");
    if (includeGoldText) row.push(unitsMap.get(s.unitId)?.text ?? "");
    rows.push(row);
  }
  return toCsv(rows);
}

async function outputsCsv(projectDir, runId) {
  const outputs = await readNdjson(path.join(projectDir, "runs", runId, "outputs.ndjson"));
  const jurors = new Set(outputs.map((o) => o.juror).filter((j) => j !== undefined));
  const multi = jurors.size > 1;
  const header = ["unitId", "label", "confidence", "escalated", "cacheHit"];
  if (multi) header.push("juror");
  const rows = [header];
  for (const o of outputs) {
    const row = [o.unitId, o.label, o.confidence ?? "", o.escalated ?? false, o.cacheHit ?? false];
    if (multi) row.push(o.juror ?? "");
    rows.push(row);
  }
  return toCsv(rows);
}

// Unit meta carries arbitrary researcher keys — including, possibly, "label",
// "pi", "adjudicated" or "unitId". The meta_ prefix keeps the reproduce-script
// merges collision-free by construction (documented in the README).
function unitsCsv(unitsMap, corpusId) {
  const units = [...unitsMap.values()].filter((u) => u.corpusId === corpusId);
  const metaKeys = [...new Set(units.flatMap((u) => Object.keys(u.meta ?? {})))].sort();
  const rows = [["unitId", ...metaKeys.map((k) => `meta_${k}`)]];
  for (const u of units) rows.push([u.id, ...metaKeys.map((k) => u.meta?.[k] ?? "")]);
  return toCsv(rows);
}

// ------------------------------------------------- members: R + Python code

// Shared script-coverage comment lines (R and python both prefix with "#").
function coverageComment(uncovered) {
  const lines = [];
  lines.push("# COVERAGE NOTE: proportion cells are script-verified;");
  lines.push("# corrected regression refits are not included — see analyses/<id>.json for");
  lines.push("# stored estimates (generated refit code is on the roadmap). Not script-covered:");
  for (const u of uncovered) lines.push(`#   - analyses/${u.id}.json (estimator ${u.estimator})`);
  return lines;
}

function rScript(plans, project, uncovered = []) {
  const L = [];
  L.push("# reproduce.R — verify Concord's DSL-corrected estimates OUTSIDE Concord.");
  L.push("#");
  L.push("# PRIMARY VERIFICATION (base R, no packages): the design-based supervised");
  L.push("# learning pseudo-outcome estimator (Egami, Hinck, Stewart, and Wei (2023);");
  L.push("# Angelopoulos, Bates, Fannjiang, Jordan, and Zrnic (2023)) is computed");
  L.push("# INLINE below — pseudo = yhat + (y - yhat)/pi on gold rows, else yhat; a");
  L.push("# cell's estimate is mean(pseudo) with HC0 sandwich");
  L.push("# se = sqrt(mean((pseudo - est)^2)/n) — and stopifnot asserts near-equality");
  L.push("# with Concord's stored numbers to 1e-6. Concord's cells are proportions of");
  L.push("# indicator(label == positive), so each block binarizes the machine and");
  L.push("# gold labels before forming the pseudo-outcome.");
  L.push("#");
  L.push("# METHODOLOGICAL CROSS-CHECK (optional): blocks with a single binarized");
  L.push("# outcome end by refitting the same estimand with the public CRAN dsl");
  L.push("# package. Its SuperLearner-anchored estimator (grf random forests,");
  L.push("# cross-fitting, internal randomness) targets the same estimand but will");
  L.push("# not match Concord's numbers to printed precision, and may fail outright");
  L.push("# on tiny gold samples. A cross-check failure does NOT invalidate the");
  L.push("# stopifnot verification above it.");
  L.push(`# Project: ${project.name} (${project.id})`);
  L.push("#   install.packages(\"dsl\")");
  L.push("");
  if (uncovered.length > 0) {
    L.push(...coverageComment(uncovered));
    L.push("");
  }
  if (plans.length === 0) {
    L.push(uncovered.length === 0
      ? "# No DSL-corrected analyses were included in this archive; nothing to refit."
      : "# No script-coverable proportion analyses in this archive; the corrected");
    if (uncovered.length > 0) L.push("# estimates above ship as stored values in analyses/<id>.json.");
    return L.join("\n") + "\n";
  }
  for (const p of plans) {
    const col = p.groupBy ? `meta_${p.groupBy}` : null;
    L.push(`# ---- analysis ${p.id}: DSL-corrected proportion of ${p.outcome}${p.groupBy ? ` by ${p.groupBy}` : ""} ----`);
    L.push(`outputs <- read.csv("outputs/${p.runId}.csv", check.names = FALSE)  # machine labels`);
    L.push(`units   <- read.csv("units/${p.corpusId}.csv", check.names = FALSE) # unit meta (meta_ prefixed)`);
    L.push(`gold    <- read.csv("gold/${p.goldsetId}.csv", check.names = FALSE) # designed gold subsample with pi`);
    L.push(`# Panel runs write one row per juror per unit PLUS one row with juror ==`);
    L.push(`# "aggregate" — the panel's aggregated verdict, which is the label Concord`);
    L.push(`# analyzes. Keep only aggregate rows, or the merges below duplicate units.`);
    L.push(`if ("juror" %in% names(outputs)) outputs <- subset(outputs, juror == "aggregate")`);
    L.push(`# Aggregate rows for flagged (no-consensus) units carry NO label; Concord`);
    L.push(`# analyzes only labeled units, so drop empty-label rows before merging.`);
    L.push(`outputs <- subset(outputs, !is.na(label) & label != "")`);
    L.push(`d <- merge(outputs, units, by = "unitId")`);
    L.push(`d <- merge(d, gold[, c("unitId", "adjudicated", "pi")], by = "unitId", all.x = TRUE)`);
    L.push(`# (meta columns are meta_ prefixed in units.csv, so these merges cannot`);
    L.push(`# collide with unitId/label/pi/adjudicated)`);
    L.push(`# Gold rows for the corrected estimator need BOTH a recorded gold label AND`);
    L.push(`# a recorded design pi: hand-queued units ship with an empty pi and stay`);
    L.push(`# out of the correction, exactly as in Concord.`);
    if (p.design === "uncertainty") {
      L.push("# NOTE: this analysis's gold sample was drawn by uncertainty targeting; the");
      L.push("# recorded pi is nominal n/N over a deterministic uncertainty ranking, so");
      L.push("# the design-based unbiasedness guarantee does not apply to these estimates.");
    }
    L.push("");
    if (p.mode === "perCell") {
      L.push("# Descriptive corrected analysis: Concord computes one corrected proportion");
      L.push("# PER LABEL VALUE over ALL units — each cell binarizes the machine and gold");
      L.push("# labels against that cell's own label (labels compare as strings).");
      L.push(`gold_lab <- as.character(d$adjudicated)`);
      L.push(`on_gold <- !is.na(d$pi) & !is.na(gold_lab) & gold_lab != ""`);
      p.cells.forEach((c, i) => {
        const k = i + 1;
        const lbl = JSON.stringify(c.group);
        L.push(`# cell ${k}: corrected proportion of label ${lbl}`);
        L.push(`yhat_${k} <- as.integer(as.character(d$label) == ${lbl})`);
        L.push(`pseudo_${k} <- as.numeric(yhat_${k})`);
        L.push(`pseudo_${k}[on_gold] <- yhat_${k}[on_gold] +`);
        L.push(`  (as.integer(gold_lab[on_gold] == ${lbl}) - yhat_${k}[on_gold]) / d$pi[on_gold]`);
        L.push(`est_${k} <- mean(pseudo_${k})`);
        L.push(`se_${k} <- sqrt(mean((pseudo_${k} - est_${k})^2) / length(pseudo_${k}))`);
        L.push(`stopifnot(abs(est_${k} - ${String(c.est)}) < 1e-6, abs(se_${k} - ${String(c.se)}) < 1e-6)`);
      });
    } else {
      if (p.mode === "positive") {
        L.push("# Concord's cells are proportions of indicator(label == positive): binarize");
        L.push("# the machine and gold labels with the positive value recorded for this");
        L.push("# analysis (results.positive). Labels compare as strings.");
        L.push(`positive <- ${JSON.stringify(p.positive)}  # recorded by Concord for this analysis`);
        L.push(`d$yhat <- as.integer(as.character(d$label) == positive)`);
        L.push(`gold_lab <- as.character(d$adjudicated)`);
        L.push(`on_gold <- !is.na(d$pi) & !is.na(gold_lab) & gold_lab != ""`);
        L.push(`d$y <- NA_real_`);
        L.push(`d$y[on_gold] <- as.integer(gold_lab[on_gold] == positive)`);
      } else {
        L.push("# No positive label value was recorded for this analysis (older archive);");
        L.push("# the machine and gold labels are used directly as numeric 0/1 outcomes.");
        L.push(`d$yhat <- as.numeric(d$label)`);
        L.push(`gold_lab <- d$adjudicated`);
        L.push(`on_gold <- !is.na(d$pi) & !is.na(gold_lab) & gold_lab != ""`);
        L.push(`d$y <- NA_real_`);
        L.push(`d$y[on_gold] <- as.numeric(gold_lab[on_gold])`);
      }
      L.push("");
      L.push("# inline pseudo-outcome estimator + verification");
      L.push(`d$pseudo <- as.numeric(d$yhat)`);
      L.push(`d$pseudo[on_gold] <- d$yhat[on_gold] + (d$y[on_gold] - d$yhat[on_gold]) / d$pi[on_gold]`);
      p.cells.forEach((c, i) => {
        const k = i + 1;
        L.push(col
          ? `ps <- d$pseudo[as.character(d[["${col}"]]) == ${JSON.stringify(c.group)}]`
          : "ps <- d$pseudo");
        L.push(`est_${k} <- mean(ps)`);
        L.push(`se_${k} <- sqrt(mean((ps - est_${k})^2) / length(ps))`);
        L.push(`stopifnot(abs(est_${k} - ${String(c.est)}) < 1e-6, abs(se_${k} - ${String(c.se)}) < 1e-6)`);
      });
    }
    if (p.diff) {
      const ia = p.cells.findIndex((c) => c.group === p.diff.a) + 1;
      const ib = p.cells.findIndex((c) => c.group === p.diff.b) + 1;
      if (ia > 0 && ib > 0) {
        L.push(`# corrected difference ${p.diff.a} - ${p.diff.b} (independent groups)`);
        L.push(`est_diff <- est_${ia} - est_${ib}`);
        L.push(`se_diff <- sqrt(se_${ia}^2 + se_${ib}^2)`);
        L.push(`stopifnot(abs(est_diff - ${String(p.diff.est)}) < 1e-6, abs(se_diff - ${String(p.diff.se)}) < 1e-6)`);
      }
    }
    L.push(`cat("OK: analysis ${p.id} reproduced Concord's stored numbers to 1e-6\\n")`);
    L.push("# Concord stored (DSL pseudo-outcome mean, HC0 sandwich SE):");
    for (const c of p.cells) {
      L.push(`#   ${p.groupBy ?? (p.mode === "perCell" ? "label" : "all")}=${c.group}: est = ${c.est.toFixed(6)}, se = ${c.se.toFixed(6)}, 95% CI [${c.ciLo.toFixed(6)}, ${c.ciHi.toFixed(6)}]`);
    }
    if (p.diff) {
      L.push(`#   difference ${p.diff.a} - ${p.diff.b}: est = ${p.diff.est.toFixed(6)}, se = ${p.diff.se.toFixed(6)}`);
    }
    L.push("");
    if (p.mode === "perCell") {
      L.push("# (dsl-package cross-check omitted for this analysis: per-label-value cells");
      L.push("# do not map onto a single outcome formula; the stopifnot verification");
      L.push("# above is the complete check.)");
      L.push("");
      continue;
    }
    L.push("# ---- METHODOLOGICAL CROSS-CHECK (not the verification) ----");
    L.push("# The CRAN dsl package refits the same estimand with its own machinery");
    L.push("# (SuperLearner-anchored outcome models via grf, cross-fitting, internal");
    L.push("# randomness). Even with the pinned seed it will not match the numbers");
    L.push("# above to printed precision, and it may fail on tiny gold samples (too");
    L.push("# few gold rows per fold). Args pinned for the record; failure here does");
    L.push("# not invalidate the stopifnot verification above.");
    if (p.groupBy) {
      L.push("# Factor coding note: with ~ 0 + factor(.) each coefficient is a cell");
      L.push("# proportion. With treatment coding (~ factor(.)) R takes the");
      L.push("# alphabetically first level as the reference and each slope estimates");
      L.push("# (level - reference), so a printed difference may need its sign flipped");
      const ref = [...p.cells.map((c) => c.group)].sort()[0];
      if (p.diff && p.cells.length === 2) {
        const flips = ref === p.diff.a;
        L.push(`# relative to the ${p.diff.a} - ${p.diff.b} contrast: here the reference is "${ref}",`);
        L.push(flips
          ? `# so the treatment-coded slope estimates ${p.diff.b} - ${p.diff.a} — the NEGATIVE of`
          : `# so the treatment-coded slope estimates ${p.diff.a} - ${p.diff.b} — the same sign as`);
        L.push("# the difference verified above.");
      } else {
        L.push(`# relative to a reported contrast (the reference here would be "${ref}").`);
      }
    }
    L.push(`d$${p.outcome}_pred <- d$yhat   # binarized machine label (prediction)`);
    L.push(`d$${p.outcome} <- d$y           # binarized human gold; NA off the gold sample`);
    L.push(`# The inline estimator above used pi only on gold rows, where the CSV`);
    L.push(`# records it. The dsl() cross-check needs pi on every row; under this`);
    L.push(`# archive's design the recorded pi applies to sampled and unsampled units`);
    L.push(`# alike. (Filled AFTER the verification so hand-queued rows — gold label,`);
    L.push(`# no pi — can never leak into the inline estimator.)`);
    if (p.uniformPi !== null && p.uniformPi !== undefined) {
      L.push(`d$pi[is.na(d$pi)] <- ${p.uniformPi}`);
    } else {
      L.push(`# (Non-uniform design: fill d$pi for unsampled units from the stratum table`);
      L.push(`# before running the cross-check.)`);
    }
    const formula = col ? `${p.outcome} ~ 0 + factor(\`${col}\`)` : `${p.outcome} ~ 1`;
    L.push("cross_check <- tryCatch({");
    L.push("  library(dsl)");
    L.push("  set.seed(20231201)");
    L.push("  fit <- dsl(model = \"lm\",");
    L.push(`             formula = ${formula},`);
    L.push(`             predicted_var = "${p.outcome}",`);
    L.push(`             prediction = "${p.outcome}_pred",`);
    L.push(`             sample_prob = "pi",`);
    L.push("             data = d)");
    L.push("  print(summary(fit))");
    L.push('}, error = function(e) message("dsl cross-check skipped: ", conditionMessage(e)))');
    L.push("");
  }
  return L.join("\n") + "\n";
}

function pyScript(plans, project, uncovered = []) {
  const anyUncertainty = plans.some((p) => p.design === "uncertainty");
  const L = [];
  L.push("#!/usr/bin/env python3");
  L.push('"""reproduce.py — re-derive Concord\'s DSL-corrected estimates from the archive');
  L.push("CSVs and ASSERT equality with Concord's stored results to 1e-6.");
  L.push("");
  L.push("Estimator (design-based supervised learning / prediction-powered inference;");
  L.push("Egami, Hinck, Stewart, and Wei (2023); Angelopoulos, Bates, Fannjiang,");
  L.push("Jordan, and Zrnic (2023)): with machine labels yhat on every unit and human gold y");
  L.push("on a designed subsample with inclusion probability pi, the pseudo-outcome");
  L.push("    pseudo_i = yhat_i + (R_i / pi_i) * (y_i - yhat_i)");
  L.push("replaces y in the moment condition. For a proportion: est = mean(pseudo) and");
  L.push("the sandwich variance (A = 1, B = mean((pseudo - est)^2)) gives");
  L.push("    se = sqrt(mean((pseudo - est)^2) / n).");
  if (anyUncertainty) {
    // the unconditional guarantee must not ship beside nominal-pi designs
    L.push("For probability designs pi is a design quantity and the estimator is");
    L.push("unbiased regardless of machine-error structure. At least one analysis below");
    L.push("used an uncertainty-targeted gold sample whose recorded pi is nominal n/N");
    L.push("over a deterministic uncertainty ranking; the design-based unbiasedness");
    L.push("guarantee does not apply to those estimates.");
  } else {
    L.push("Unbiased regardless of machine-error structure because pi is a design quantity.");
  }
  L.push("");
  L.push("Concord's cells are proportions of indicator(label == positive), so each");
  L.push("analysis block binarizes the machine and gold labels before forming the");
  L.push("pseudo-outcome (per cell for descriptive analyses).");
  L.push("");
  L.push(`Project: ${project.name} (${project.id}). Requires numpy and pandas.`);
  L.push('"""');
  L.push("import math");
  L.push("");
  L.push("import numpy as np");
  L.push("import pandas as pd");
  L.push("");
  L.push("");
  L.push("def dsl_proportion(yhat, y, pi):");
  L.push('    """DSL pseudo-outcome mean + sandwich SE. y is NaN off the gold sample."""');
  L.push("    yhat = np.asarray(yhat, dtype=float)");
  L.push("    y = np.asarray(y, dtype=float)");
  L.push("    pi = np.asarray(pi, dtype=float)");
  L.push("    pseudo = yhat.copy()");
  L.push("    gold = ~np.isnan(y)");
  L.push("    pseudo[gold] = yhat[gold] + (y[gold] - yhat[gold]) / pi[gold]");
  L.push("    n = pseudo.size");
  L.push("    est = pseudo.mean()");
  L.push("    b = float(np.mean((pseudo - est) ** 2))  # sandwich middle, A = 1");
  L.push("    return float(est), math.sqrt(b / n)");
  L.push("");
  L.push("");
  L.push("def label_text(series):");
  L.push('    """Labels compare as strings; whole-number floats normalize (1.0 -> "1")."""');
  L.push('    s = series.astype(str).str.strip()');
  L.push('    return s.str.replace(r"\\.0$", "", regex=True)');
  L.push("");
  L.push("");
  L.push("def check(name, got, want, tol=1e-6):");
  L.push('    assert abs(got - want) < tol, f"{name}: recomputed {got!r} != Concord stored {want!r}"');
  L.push('    print(f"  OK {name}: {got:.10f} == {want:.10f} (tol {tol})")');
  L.push("");
  L.push("");
  if (uncovered.length > 0) {
    L.push(...coverageComment(uncovered));
    L.push("");
  }
  if (plans.length === 0) {
    L.push(uncovered.length === 0
      ? 'print("No DSL-corrected analyses in this archive; nothing to verify.")'
      : 'print("No script-coverable proportion analyses; corrected estimates ship as stored values in analyses/<id>.json.")');
    return L.join("\n") + "\n";
  }
  for (const p of plans) {
    L.push(`# ---- analysis ${p.id}: corrected proportion of ${p.outcome}${p.groupBy ? ` by ${p.groupBy}` : ""} ----`);
    L.push(`print("analysis ${p.id}")`);
    L.push(`outputs = pd.read_csv("outputs/${p.runId}.csv")`);
    L.push("# Panel runs write one row per juror per unit PLUS one row with");
    L.push('# juror == "aggregate" — the panel\'s aggregated verdict, which is the label');
    L.push("# Concord analyzes. Keep only aggregate rows, or the merges below would");
    L.push("# duplicate every unit and silently corrupt the estimates.");
    L.push('if "juror" in outputs.columns:');
    L.push('    outputs = outputs[outputs["juror"] == "aggregate"]');
    L.push("# Aggregate rows for flagged (no-consensus) units carry NO label; Concord");
    L.push("# analyzes only labeled units, so drop empty-label rows before merging.");
    L.push('outputs = outputs[outputs["label"].notna() & (label_text(outputs["label"]) != "")]');
    L.push(`units = pd.read_csv("units/${p.corpusId}.csv")  # unit meta (meta_ prefixed)`);
    L.push(`gold = pd.read_csv("gold/${p.goldsetId}.csv")`);
    L.push('d = outputs.merge(units, on="unitId").merge(');
    L.push('    gold[["unitId", "adjudicated", "pi"]], on="unitId", how="left")');
    L.push("# Gold rows for the corrected estimator need BOTH a recorded gold label AND");
    L.push("# a recorded design pi: hand-queued units ship with an empty pi and stay");
    L.push("# out of the correction, exactly as in Concord.");
    L.push('on_gold = d["adjudicated"].notna() & d["pi"].notna()');
    if (p.design === "uncertainty") {
      L.push("# NOTE: this analysis's gold sample was drawn by uncertainty targeting; the");
      L.push("# recorded pi is nominal n/N over a deterministic uncertainty ranking, so");
      L.push("# the design-based unbiasedness guarantee does not apply to these estimates.");
    }
    if (p.mode === "positive") {
      L.push(`positive = ${JSON.stringify(p.positive)}  # recorded by Concord for this analysis (results.positive)`);
      L.push('d["yhat"] = (label_text(d["label"]) == positive).astype(float)');
      L.push('d["y"] = np.where(on_gold, (label_text(d["adjudicated"]) == positive).astype(float), np.nan)');
    } else if (p.mode === "numeric") {
      L.push("# No positive label value was recorded for this analysis (older archive);");
      L.push("# the machine and gold labels are used directly as numeric 0/1 outcomes.");
      L.push('d["yhat"] = pd.to_numeric(d["label"], errors="coerce")');
      L.push('d["y"] = np.where(on_gold, pd.to_numeric(d["adjudicated"], errors="coerce"), np.nan)');
    } else {
      L.push("# Descriptive corrected analysis: one corrected proportion PER LABEL VALUE");
      L.push("# over ALL units — each cell binarizes against its own label below.");
    }
    L.push("cells = {}");
    L.push("for group, want_est, want_se in [");
    for (const c of p.cells) {
      L.push(`    (${JSON.stringify(c.group)}, ${String(c.est)}, ${String(c.se)}),`);
    }
    L.push("]:");
    if (p.mode === "perCell") {
      L.push("    # each cell's label value is its own positive: binarize per cell");
      L.push('    yhat = (label_text(d["label"]) == group).astype(float)');
      L.push('    y = np.where(on_gold, (label_text(d["adjudicated"]) == group).astype(float), np.nan)');
      L.push('    est, se = dsl_proportion(yhat, y, d["pi"])');
    } else {
      if (p.groupBy) {
        L.push(`    sub = d[label_text(d[${JSON.stringify(`meta_${p.groupBy}`)}]) == group]`);
      } else {
        L.push("    sub = d");
      }
      L.push('    est, se = dsl_proportion(sub["yhat"], sub["y"], sub["pi"])');
    }
    const groupKey = p.groupBy ?? (p.mode === "perCell" ? "label" : "cell");
    L.push('    check(f"' + groupKey + '={group} est", est, want_est)');
    L.push('    check(f"' + groupKey + '={group} se", se, want_se)');
    L.push("    cells[group] = (est, se)");
    if (p.diff) {
      L.push(`# corrected difference ${p.diff.a} - ${p.diff.b} (independent groups)`);
      L.push(`est = cells[${JSON.stringify(p.diff.a)}][0] - cells[${JSON.stringify(p.diff.b)}][0]`);
      L.push(`se = math.sqrt(cells[${JSON.stringify(p.diff.a)}][1] ** 2 + cells[${JSON.stringify(p.diff.b)}][1] ** 2)`);
      L.push(`check("diff ${p.diff.a}-${p.diff.b} est", est, ${String(p.diff.est)})`);
      L.push(`check("diff ${p.diff.a}-${p.diff.b} se", se, ${String(p.diff.se)})`);
    }
    L.push("");
  }
  if (uncovered.length > 0) {
    L.push('print("All script-covered Concord numbers reproduced to 1e-6. Corrected regression"');
    L.push('      " estimates were not refit; see analyses/<id>.json for stored values.")');
  } else {
    L.push('print("All Concord numbers reproduced to 1e-6.")');
  }
  return L.join("\n") + "\n";
}

// -------------------------------------------------------------------- build

export async function build(project, analysisIds, { projectDir, includeGoldText = true } = {}) {
  if (!project || typeof project !== "object" || !project.id) fail("build requires a project object");
  if (!Array.isArray(analysisIds) || analysisIds.length === 0 || analysisIds.some((a) => typeof a !== "string" || !a)) {
    fail("build requires a non-empty array of analysis ids", { analysisIds });
  }
  if (typeof projectDir !== "string" || !projectDir) fail("build requires options.projectDir");

  const analyses = [];
  for (const id of analysisIds) analyses.push(await loadAnalysis(project, projectDir, id));

  // resolve referenced runs/corpora; load goldsets and units
  const runs = new Map();
  for (const a of analyses) {
    const runId = a.spec?.runId;
    if (runId && !runs.has(runId)) {
      const run = await loadRun(projectDir, runId);
      if (run) runs.set(runId, run);
    }
  }
  const corpusIds = [...new Set([
    ...analyses.map((a) => a.spec?.corpusId).filter(Boolean),
    ...[...runs.values()].map((r) => r.corpusId).filter(Boolean),
  ])];
  const unitsMap = await loadUnitsMap(projectDir, corpusIds);
  const goldsets = [];
  for (const meta of project.goldsets ?? []) {
    const g = await loadGoldset(project, projectDir, meta.id);
    if (g?.sample) goldsets.push(g);
  }

  // reproduce-script plans (one per script-coverable DSL proportion analysis)
  const plans = [];
  for (const a of analyses) {
    const plan = dslPlan(a, runs.get(a.spec?.runId));
    if (!plan) continue;
    const gs = goldsets.find((g) => g.id === plan.goldsetId);
    // uniform-pi check over RECORDED pi only: hand-queued rows carry pi null
    // and must not break (or fake) the uniform fill the cross-check uses
    const pis = [...new Set((gs?.sample ?? []).map((x) => x.pi).filter((p) => typeof p === "number" && Number.isFinite(p)))];
    plan.uniformPi = pis.length === 1 ? pis[0] : null;
    plan.design = gs?.design ?? null;
    plans.push(plan);
  }
  // corrected analyses the scripts CANNOT refit (regressions, PPI fits,
  // cell-less results): the scripts and README must say so instead of
  // claiming the archive holds no corrected analyses
  const covered = new Set(plans.map((p) => p.id));
  const uncovered = analyses
    .filter((a) => {
      const est = String(a.results?.estimator ?? a.spec?.estimator ?? "");
      return a.level === "corrected" && /^(dsl|ppi)/.test(est) && !covered.has(a.id);
    })
    .map((a) => ({ id: a.id, estimator: String(a.results?.estimator ?? a.spec?.estimator ?? "") }));

  // ---- members (path → utf8 string)
  const members = new Map();
  members.set("README.md", readmeMd(project, analyses, includeGoldText, uncovered));
  members.set("codebook.md", codebookMd(project));
  for (const inst of project.instruments ?? []) {
    const member = inst.kind === "dictionary" ? `dictionaries/${inst.id}.json` : `instruments/${inst.id}.json`;
    members.set(member, JSON.stringify(inst, null, 2) + "\n");
  }
  for (const g of goldsets) members.set(`gold/${g.id}.csv`, goldCsv(g, unitsMap, includeGoldText));
  for (const runId of runs.keys()) members.set(`outputs/${runId}.csv`, await outputsCsv(projectDir, runId));
  for (const corpusId of corpusIds) members.set(`units/${corpusId}.csv`, unitsCsv(unitsMap, corpusId));
  members.set("agreement.json", JSON.stringify({
    instruments: (project.instruments ?? []).map((i) => ({
      id: i.id, name: i.name, kind: i.kind, level: i.level, versionHash: i.versionHash,
      frozen: i.frozen ?? false, stability: i.stability ?? null, certificate: i.certificate ?? null,
    })),
    goldsets: goldsets.map((g) => ({
      id: g.id, tier: g.tier, design: g.design, status: g.status,
      n: g.sample?.length ?? 0, humanAgreement: g.humanAgreement ?? null,
    })),
  }, null, 2) + "\n");
  for (const a of analyses) members.set(`analyses/${a.id}.json`, JSON.stringify(a, null, 2) + "\n");
  members.set("reproduce.R", rScript(plans, project, uncovered));
  members.set("reproduce.py", pyScript(plans, project, uncovered));

  // ---- MANIFEST last: sha256 of every member, itself excluded
  const files = {};
  for (const p of [...members.keys()].sort()) files[p] = sha256(members.get(p));
  const manifest = {
    format: "concord-replication/1",
    generator: "concord",
    projectId: project.id,
    projectName: project.name,
    slug: project.slug,
    createdAt: project.createdAt,
    analyses: analysisIds,
    includesGoldText: includeGoldText,
    files,
  };
  const manifestStr = JSON.stringify(manifest, null, 2) + "\n";
  members.set("MANIFEST.json", manifestStr);

  // ---- deterministic zip: sorted paths, mtime from project.createdAt
  let mtime = new Date(project.createdAt ?? "2000-01-01T00:00:00.000Z");
  if (Number.isNaN(mtime.getTime()) || mtime.getFullYear() < 1980) mtime = new Date("2000-01-01T00:00:00.000Z");
  const zippable = {};
  for (const p of [...members.keys()].sort()) zippable[p] = strToU8(members.get(p));
  const zipBuffer = Buffer.from(zipSync(zippable, { level: 6, mtime }));

  await ledger.append(projectDir, "system", "export.replication", { projectId: project.id }, {
    manifestHash: sha256(manifestStr),
    analyses: analysisIds,
    files: members.size,
    includesGoldText: includeGoldText,
  });

  return { zipBuffer, manifest };
}
