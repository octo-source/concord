// Runs: preflight (estimate only — nothing persists), start (budget gate →
// engine.createRun → background executeRun with Director escalation and the
// drift tripwire armed on calibrated instruments), live monitor (SSE),
// pause/resume/abort, escalation queue, and the disagreement view.
//
// Pause/abort ride the engine's shouldStop hook: the route flips a per-run
// control flag ("pause"|"abort"); the engine probes it at every unit
// dispatch, drains in-flight pool work, writes the resumable status itself
// and settles. The route answers only after the run's promise settles, so
// the status it reports is the status on disk.
import { ConcordError } from "../core/errors.js";
import { sse } from "../router.js";
import { loadProject, updateProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { getAdapter } from "../providers/registry.js";
import { estimateRun, checkBudget } from "../providers/costs.js";
import * as engineMod from "../runs/engine.js";
import * as monitor from "../runs/monitor.js";
import { makeEscalator } from "../director/escalate.js";
import { directorCosts } from "../director/director.js";
import { entropy as panelEntropy } from "../instruments/panel.js";
import {
  findOr404, requireBody, pdirOf, readCorpusUnits, unitsById, readGoldset,
  goldLabelMap, addSpend, readNdjson, runOutputsFile, round6, labelKey,
  writeJsonAtomic, corpusDisplayName, validateName,
} from "./_shared.js";
// the replication archive's CSV writer is the single home for RFC-4180
// quoting + formula-injection hardening — reused here, never duplicated
import { toCsv } from "../reporting/replication.js";
import path from "node:path";

// The engine persists runs in project.runs (the Wave-1 amendment), but the
// reporting modules (methods.loadRun, replication outputs members) read
// runs/<id>/run.json from the bundle. The routes layer bridges the seam by
// snapshotting the run record into its directory whenever it settles.
async function snapshotRun(slug, runId) {
  try {
    const project = await loadProject(slug);
    const run = (project.runs ?? []).find((r) => r.id === runId);
    if (run) await writeJsonAtomic(path.join(pdirOf(slug), "runs", runId, "run.json"), run);
    return run ?? null;
  } catch {
    return null; // snapshot is plumbing for reporting — never fails a run
  }
}

// ------------------------------------------------------- estimate (no side effects)

function jurorPayloadsOf(instrument) {
  if (instrument.kind === "judge") return [instrument.payload];
  if (instrument.kind === "panel") return instrument.payload?.jurors ?? [];
  return []; // dictionary: local, $0
}

async function estimateInstrument(project, instrument, units) {
  if (instrument.kind === "dictionary") {
    return { calls: units.length, inputTokens: 0, outputTokens: 0, estUSD: 0, etaMin: 0, privacyOk: true };
  }
  let est = { calls: 0, inputTokens: 0, outputTokens: 0, estUSD: 0, etaMin: 0 };
  let privacyOk = true;
  let privacyError = null;
  for (const j of jurorPayloadsOf(instrument)) {
    let pricing = { inUSDper1M: 0, outUSDper1M: 0 };
    try {
      const { adapter } = getAdapter(project, j.provider);
      const cat = await adapter.catalog().catch(() => []);
      pricing = cat.find((e) => e.id === j.model || e.snapshot === j.model)?.pricing ?? pricing;
    } catch (err) {
      if (err?.code === "PRIVACY_BLOCKED") {
        privacyOk = false;
        privacyError = err.message;
      } else {
        throw err;
      }
    }
    const e = estimateRun({
      units,
      template: j.promptTemplate ?? "",
      maxTokens: j.params?.maxTokens ?? 256,
      pricing,
    });
    est = {
      calls: est.calls + e.calls,
      inputTokens: est.inputTokens + e.inputTokens,
      outputTokens: est.outputTokens + e.outputTokens,
      estUSD: round6(est.estUSD + e.estUSD),
      etaMin: Math.round((est.etaMin + e.etaMinutes) * 10) / 10,
    };
  }
  return { ...est, privacyOk, ...(privacyError ? { privacyError } : {}) };
}

// ------------------------------------------------------------ live registry

// runId → {control: null|"pause"|"abort", subs:Set<{tick,done}>, last,
// terminal, promise}. `control` is what the engine's shouldStop hook reads.
const live = new Map();

function armDrift(project, instrument, runId) {
  // calibrated instruments re-judge certificate gold units every 2000 outputs
  if (!instrument.frozen || !instrument.certificate?.goldsetId) return Promise.resolve();
  return (async () => {
    const gs = await readGoldset(project.slug, instrument.certificate.goldsetId);
    const gold = goldLabelMap(gs);
    if (gold.size === 0) return;
    const found = await unitsById(project, [...gold.keys()], { corpusId: gs.corpusId });
    const goldOutputs = [...found.values()].map((u) => ({ unit: u, label: gold.get(u.id) }));
    if (goldOutputs.length === 0) return;
    monitor.armDriftTripwire(runId, { project, goldOutputs, instrument });
  })().catch(() => { /* best-effort: a missing goldset never blocks a run */ });
}

function startExecution(slug, runId, { escalate } = {}) {
  const st = {
    control: null, // null | "pause" | "abort" — read by the engine's shouldStop hook
    subs: new Set(),
    last: null,
    terminal: null,
  };
  live.set(runId, st);
  st.promise = (async () => {
    let cost0 = 0;
    let dir0 = 0;
    let projectForMeter = null;
    try {
      const project = await loadProject(slug);
      projectForMeter = project;
      cost0 = (project.runs ?? []).find((r) => r.id === runId)?.cost?.actualUSD ?? 0;
      dir0 = directorCosts(project).usd;
    } catch { /* metered roll-up degrades gracefully */ }

    let outcome;
    try {
      // pause/abort land through shouldStop: the engine stops dispatching,
      // drains in-flight pool work and writes the resumable status itself —
      // by the time this resolves, the status is already on disk
      const run = await engineMod.executeRun(slug, runId, {
        ...(escalate ? { escalate } : {}),
        shouldStop: () => st.control,
        onTick: (s) => {
          st.last = s;
          for (const sub of st.subs) {
            try { sub.tick(s); } catch { /* subscriber gone */ }
          }
        },
      });
      outcome = { status: run.status };
    } catch (err) {
      outcome = { status: "failed", error: { code: err?.code ?? "INTERNAL", message: err?.message ?? String(err) } };
      // Backstop: the engine persists its own terminal statuses, but a throw
      // BEFORE that persistence (validation/config faults in setup) would
      // strand the disk record at "running" — Pause/Abort would 400 and the
      // monitor would replay failed-vs-running forever. Settle the disk.
      try {
        await updateProject(slug, (p) => {
          const r = (p.runs ?? []).find((x) => x.id === runId);
          if (r && r.status === "running") {
            r.status = "failed";
            r.error = outcome.error;
          }
        });
      } catch { /* best-effort — the registry outcome still reports failed */ }
    }

    // cost roll-up: this execution's run-cost delta plus any Director
    // escalation spend metered during it
    try {
      const fresh = await loadProject(slug);
      const run = (fresh.runs ?? []).find((r) => r.id === runId);
      const dirDelta = projectForMeter ? Math.max(0, directorCosts(projectForMeter).usd - dir0) : 0;
      const delta = Math.max(0, (run?.cost?.actualUSD ?? 0) - cost0) + dirDelta;
      if (delta > 0) await addSpend(slug, delta);
      outcome.run = run ?? null;
    } catch { /* roll-up is best-effort */ }
    outcome.run = (await snapshotRun(slug, runId)) ?? outcome.run ?? null;

    st.terminal = outcome;
    for (const sub of [...st.subs]) {
      try { sub.done(outcome); } catch { /* subscriber gone */ }
    }
    st.subs.clear();
    return outcome;
  })();
  return st;
}

async function launchRun(params, { resume = false } = {}) {
  const project = await loadProject(params.p);
  const run = findOr404(project.runs, params.r ?? params.runId, "run");
  const instrument = findOr404(project.instruments, run.instrumentId, "instrument");
  const construct = findOr404(project.constructs, instrument.constructId, "construct");
  if (run.status === "complete") {
    throw new ConcordError("VALIDATION", `run '${run.id}' is already complete`, { runId: run.id });
  }
  const current = live.get(run.id);
  if (current && !current.terminal) {
    throw new ConcordError("VALIDATION", `run '${run.id}' is already executing`, { runId: run.id });
  }
  await armDrift(project, instrument, run.id);
  const escalate = project.director ? makeEscalator(project, construct) : undefined;
  // Persist "running" BEFORE answering: the engine runs in the background and
  // persists at its own pace, so a client that refreshes right after this
  // response would otherwise read the stale pending/paused status, render a
  // static screen, and never subscribe to the monitor — runs proceeding
  // invisibly was a field report. The engine treats running(stale) as
  // resumable, so this write is always consistent with what follows.
  await updateProject(params.p, (p) => {
    const r = (p.runs ?? []).find((x) => x.id === run.id);
    if (r && r.status !== "complete") {
      r.status = "running";
      delete r.error; // a fresh launch clears ORPHANED/paused explanations
    }
  });
  startExecution(params.p, run.id, { escalate });
  return { runId: run.id, status: "running", resumed: resume };
}

// ------------------------------------------------------------------ routes

export default [
  {
    method: "POST",
    pattern: "/api/projects/:p/runs/preflight",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["instrumentId", "corpusId"]);
      const instrument = findOr404(project.instruments, body.instrumentId, "instrument");
      findOr404(project.corpora, body.corpusId, "corpus");
      const units = await readCorpusUnits(params.p, body.corpusId);
      const est = await estimateInstrument(project, instrument, units);
      const capUSD = project.budget?.capUSD ?? null;
      const spentUSD = project.budget?.spentUSD ?? 0;
      return {
        units: units.length,
        calls: est.calls,
        inputTokens: est.inputTokens,
        outputTokens: est.outputTokens,
        estUSD: est.estUSD,
        etaMin: est.etaMin,
        privacyOk: est.privacyOk,
        ...(est.privacyError ? { privacyError: est.privacyError } : {}),
        budget: {
          capUSD,
          spentUSD,
          wouldExceed: capUSD !== null && spentUSD + est.estUSD >= capUSD,
        },
      };
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/runs",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = requireBody(req, ["instrumentId", "corpusId"]);
      const instrument = findOr404(project.instruments, body.instrumentId, "instrument");
      const construct = findOr404(project.constructs, instrument.constructId, "construct");
      const corpus = findOr404(project.corpora, body.corpusId, "corpus");

      // privacy: constructing the adapters is the gate (403 on strict violations)
      for (const j of jurorPayloadsOf(instrument)) getAdapter(project, j.provider);

      // budget: spent + estimate against the project cap → 400 BUDGET_EXCEEDED
      const units = await readCorpusUnits(params.p, body.corpusId, body.unitFilter ? { filter: engineMod.parseUnitFilter(body.unitFilter) } : {});
      const est = await estimateInstrument(project, instrument, units);
      checkBudget((project.budget?.spentUSD ?? 0) + est.estUSD, project.budget?.capUSD ?? null);

      // Auto-name "<instrument> · <corpus display>" — a human-readable handle
      // for a run the researcher can later rename. The body may override it.
      const autoName = `${instrument.name} · ${corpusDisplayName(corpus)}`;
      const run = await engineMod.createRun(project, {
        instrumentId: body.instrumentId,
        corpusId: body.corpusId,
        ...(body.unitFilter !== undefined ? { unitFilter: body.unitFilter } : {}),
        ...(body.capUSD !== undefined ? { capUSD: body.capUSD } : {}),
        name: typeof body.name === "string" && body.name !== "" ? body.name : autoName,
      });
      await armDrift(project, instrument, run.id);
      const escalate = project.director ? makeEscalator(project, construct) : undefined;
      startExecution(params.p, run.id, { escalate });
      return { runId: run.id, estUSD: run.cost.estUSD, total: run.checkpoint.total };
    },
  },
  {
    // Rename: a run's `name` is a human-facing label, not provenance — editing
    // it is NOT a ledgered scientific act, so this writes the project graph and
    // returns the run without appending any event.
    method: "PUT",
    pattern: "/api/projects/:p/runs/:r",
    handler: async (req, res, params) => {
      const body = requireBody(req, ["name"]);
      const name = validateName(body.name, "name");
      let updated = null;
      await updateProject(params.p, (p) => {
        const run = (p.runs ?? []).find((x) => x.id === params.r);
        if (!run) throw new ConcordError("NOT_FOUND", `run '${params.r}' not found`, { id: params.r });
        run.name = name;
        updated = run;
      });
      await snapshotRun(params.p, params.r);
      return updated;
    },
  },
  {
    // Live monitor: tick events while the run executes in this process, then
    // one done event with the settled run record.
    method: "GET",
    pattern: "/api/projects/:p/runs/:r/monitor",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const run = findOr404(project.runs, params.r, "run");
      const conn = sse(res);
      const st = live.get(params.r);

      const tickFromRun = (r) => ({
        done: r.checkpoint?.done ?? 0,
        total: r.checkpoint?.total ?? 0,
        costUSD: r.cost?.actualUSD ?? 0,
        // the engine persists labelDist at checkpoints and completion — a
        // cold tick reports the stored distribution, not an empty one
        labelDist: r.labelDist ?? {},
        warnings: [],
        escalations: r.escalation?.count ?? 0,
      });
      const doneOf = (r, status) => ({
        runId: params.r,
        status: status ?? r?.status ?? "unknown",
        checkpoint: r?.checkpoint ?? null,
        cost: r?.cost ?? null,
        quarantine: r?.quarantine ?? [],
        escalations: r?.escalation?.count ?? 0,
      });

      if (st && !st.terminal) {
        conn.send("tick", st.last ?? monitor.runState(params.r) ?? tickFromRun(run));
        const sub = {
          tick: (s) => conn.send("tick", s),
          done: (outcome) => {
            conn.send("done", doneOf(outcome.run, outcome.status));
            conn.close();
          },
        };
        st.subs.add(sub);
        conn.onClose(() => st.subs.delete(sub));
        // settle race: if the run terminated between the check above and the
        // subscription, deliver done from the settled promise instead of
        // waiting on a notification that already fired
        st.promise.then((outcome) => {
          if (st.subs.has(sub)) {
            st.subs.delete(sub);
            sub.done(outcome);
          }
        }).catch(() => {});
        return;
      }
      if (st?.terminal) {
        conn.send("tick", st.last ?? tickFromRun(st.terminal.run ?? run));
        conn.send("done", doneOf(st.terminal.run ?? run, st.terminal.status));
        conn.close();
        return;
      }
      // Not executing in this process: report the persisted state. A record
      // still saying "running" here is an ORPHAN — the process that ran it is
      // gone (restart/crash mid-run). Heal it to paused (resume is exactly-
      // once off the outputs on disk) BEFORE answering; replaying "running"
      // for a run nothing is running once looped the client into a re-render
      // flicker.
      let settled = run;
      if (run.status === "running") {
        const fresh = await updateProject(params.p, (p) => {
          const r = (p.runs ?? []).find((x) => x.id === params.r);
          if (r && r.status === "running") {
            r.status = "paused";
            r.error = {
              code: "ORPHANED",
              message: "the server stopped while this run was executing; resume continues from the checkpoint",
            };
          }
        });
        settled = (fresh.runs ?? []).find((x) => x.id === params.r) ?? run;
        await snapshotRun(params.p, params.r);
      }
      conn.send("tick", monitor.runState(params.r) ?? tickFromRun(settled));
      conn.send("done", doneOf(settled));
      conn.close();
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/runs/:r/pause",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const run = findOr404(project.runs, params.r, "run");
      const st = live.get(params.r);
      if (st && !st.terminal) {
        st.control = "pause";
        // settle: the engine drains and writes the status before we answer;
        // a run that finished before noticing reports its true status
        const outcome = await st.promise.catch(() => null);
        return { runId: params.r, status: outcome?.status ?? "paused" };
      }
      if (run.status === "paused") return { runId: params.r, status: "paused" };
      throw new ConcordError("VALIDATION", `run '${params.r}' is not executing (status: ${run.status})`, { status: run.status });
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/runs/:r/resume",
    handler: async (req, res, params) => launchRun({ p: params.p, r: params.r }, { resume: true }),
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/runs/:r/abort",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const run = findOr404(project.runs, params.r, "run");
      const st = live.get(params.r);
      if (st && !st.terminal) {
        st.control = "abort";
        const outcome = await st.promise.catch(() => null);
        if (outcome?.status === "aborted") {
          // the engine wrote the status; the human event is the route's to ledger
          await ledger.append(pdirOf(params.p), "human", "run.aborted", { runId: params.r }, { by: "human" }).catch(() => {});
        }
        return { runId: params.r, status: outcome?.status ?? "aborted" };
      }
      if (run.status === "complete") {
        throw new ConcordError("VALIDATION", "run is already complete", { runId: params.r });
      }
      if (run.status !== "aborted") {
        await updateProject(params.p, (p) => {
          const r = (p.runs ?? []).find((x) => x.id === params.r);
          if (r) r.status = "aborted";
        });
        await ledger.append(pdirOf(params.p), "human", "run.aborted", { runId: params.r }, { by: "human" });
        await snapshotRun(params.p, params.r);
      }
      return { runId: params.r, status: "aborted" };
    },
  },
  {
    method: "GET",
    pattern: "/api/projects/:p/runs/:r/escalations",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      findOr404(project.runs, params.r, "run");
      return readNdjson(runOutputsFile(params.p, params.r), { filter: (o) => o.escalated === true });
    },
  },
  {
    // Labeled-data export: the researcher's file back with the run's verdicts
    // appended. Every unit meta column under its ORIGINAL name, the unit text
    // under the corpus's textColumn, then <construct> / <construct>_confidence
    // (when any output carries one) / <construct>_escalated /
    // <construct>_error (when anything quarantined), and unit_id last.
    // Appended columns suffix _2, _3… when a meta key already claims the name.
    // The CSV stays machine-pure (no comment preamble): an incomplete run is
    // signalled by "-partial" in the FILENAME instead.
    method: "GET",
    pattern: "/api/projects/:p/runs/:r/export.csv",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const run = findOr404(project.runs, params.r, "run");
      const instrument = findOr404(project.instruments, run.instrumentId, "instrument");
      const construct = findOr404(project.constructs, instrument.constructId, "construct");
      const corpus = findOr404(project.corpora, run.corpusId, "corpus");
      const units = await readCorpusUnits(params.p, run.corpusId,
        run.unitFilter ? { filter: engineMod.parseUnitFilter(run.unitFilter) } : {});

      // One final verdict per unit: the judge line, or the aggregate line for
      // panels — keyed on the hash the run RAN under (run.versionHash), never
      // the instrument's current hash: an unfrozen instrument edited after the
      // run would otherwise export every label blank.
      const fin = engineMod.finalJurorOfRun(run, instrument);
      const outputs = await readNdjson(runOutputsFile(params.p, params.r), { filter: (o) => o.juror === fin });
      const finals = new Map(outputs.map((o) => [o.unitId, o]));
      const quarantined = new Map(engineMod.normalizeQuarantine(run.quarantine).map((q) => [q.unitId, q.code ?? ""]));
      const anyConfidence = outputs.some((o) => o.confidence !== undefined && o.confidence !== null);

      // meta columns keep their original names and first-seen order — this is
      // the researcher's own file coming back, not a merge artifact
      const metaKeys = [];
      const used = new Set();
      for (const u of units) {
        for (const k of Object.keys(u.meta ?? {})) {
          if (!used.has(k)) {
            used.add(k);
            metaKeys.push(k);
          }
        }
      }
      const uniq = (base) => {
        let name = base;
        for (let k = 2; used.has(name); k++) name = `${base}_${k}`;
        used.add(name);
        return name;
      };
      const textCol = uniq(corpus.textColumn ?? corpus.unitization?.textColumn ?? "text");
      const labelCol = uniq(construct.name);
      const confidenceCol = anyConfidence ? uniq(`${construct.name}_confidence`) : null;
      const escalatedCol = uniq(`${construct.name}_escalated`);
      const errorCol = quarantined.size > 0 ? uniq(`${construct.name}_error`) : null;
      const idCol = uniq("unit_id");

      const header = [...metaKeys, textCol, labelCol];
      if (confidenceCol) header.push(confidenceCol);
      header.push(escalatedCol);
      if (errorCol) header.push(errorCol);
      header.push(idCol);

      const rows = [header];
      for (const u of units) {
        const o = finals.get(u.id);
        const row = metaKeys.map((k) => u.meta?.[k] ?? "");
        row.push(u.text ?? "", o ? o.label : "");
        if (confidenceCol) row.push(o?.confidence ?? "");
        row.push(o?.escalated === true ? true : "");
        if (errorCol) row.push(quarantined.get(u.id) ?? "");
        row.push(u.id);
        rows.push(row);
      }

      const constructSlug = String(construct.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "construct";
      const partial = run.status === "complete" ? "" : "-partial";
      const body = toCsv(rows);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${project.slug}-${constructSlug}-${run.id}${partial}.csv"`,
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    },
  },
  {
    // Entropy-ranked disagreement from the panel's per-juror lines plus a
    // juror×juror percent-agreement matrix.
    method: "GET",
    pattern: "/api/projects/:p/runs/:r/disagreement",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const run = findOr404(project.runs, params.r, "run");
      const instrument = findOr404(project.instruments, run.instrumentId, "instrument");
      const lines = await readNdjson(runOutputsFile(params.p, params.r), {
        filter: (o) => o.juror !== "aggregate",
      });
      const byUnit = new Map();
      for (const l of lines) {
        let m = byUnit.get(l.unitId);
        if (!m) byUnit.set(l.unitId, (m = new Map()));
        m.set(l.juror, l);
      }
      const jurors = [...new Set(lines.map((l) => l.juror))].sort();
      if (instrument.kind !== "panel" || jurors.length < 2) {
        return {
          byEntropy: [],
          jurorMatrix: { jurors, matrix: [] },
          note: "disagreement requires a panel run with at least two jurors",
        };
      }

      const byEntropy = [];
      for (const [unitId, m] of byUnit) {
        const labels = [...m.values()].map((o) => o.label).filter((l) => l !== undefined);
        if (labels.length < 2) continue;
        const h = panelEntropy(labels);
        if (h <= 0) continue;
        byEntropy.push({
          unitId,
          entropy: Math.round(h * 1000) / 1000,
          labels: Object.fromEntries([...m.entries()].map(([j, o]) => [j, o.label])),
        });
      }
      byEntropy.sort((a, b) => b.entropy - a.entropy || (a.unitId < b.unitId ? -1 : 1));

      const matrix = jurors.map((a) => jurors.map((b) => {
        if (a === b) return 1;
        let agree = 0;
        let n = 0;
        for (const m of byUnit.values()) {
          const oa = m.get(a);
          const ob = m.get(b);
          if (!oa || !ob || oa.label === undefined || ob.label === undefined) continue;
          n++;
          if (labelKey(oa.label) === labelKey(ob.label)) agree++;
        }
        return n > 0 ? Math.round((agree / n) * 1000) / 1000 : null;
      }));

      return { byEntropy: byEntropy.slice(0, 200), jurorMatrix: { jurors, matrix } };
    },
  },
];
