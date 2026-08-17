// The Corpus Brief: the Director's first-read memo over a stratified sample.
// One Director call; every claim carries unit refs that are validated against
// the sample actually shown (invalid refs are dropped and counted as an issue
// — a Director that cites unseen units is exhibiting exactly the failure mode
// the evidence discipline exists to catch). The brief is persisted as
// briefs/<id>.json (authoredBy: "director"), registered on project.briefs,
// and ledgered as `brief.generated` (taxonomy addition approved in review).
import { ConcordError } from "../core/errors.js";
import { newId } from "../core/ids.js";
import { updateProject, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { detect } from "../ingest/mapping.js";
import { callDirector, readCorpusUnits, seededSample, writeArtifact } from "./director.js";
import { briefPrompt, BRIEF_SCHEMA } from "./prompts.js";

// Sample-size policy: read everything for small corpora; otherwise 10% of the
// corpus clamped to the design doc's 200–500 band.
export function briefSampleTarget(total) {
  if (total <= 200) return total;
  return Math.min(500, Math.max(200, Math.ceil(total * 0.1)));
}

// Stratified seeded sample: length terciles × up to 6 cells of the first
// categorical metadata column (per ingest/mapping detection). Deterministic
// for a given corpus (seeded by corpusId), so a regenerated brief reads the
// same evidence.
export function stratifiedSample(units, corpusId, target) {
  // length terciles over the whole corpus
  const lens = units.map((u) => (u.text ?? "").length).sort((a, b) => a - b);
  const t1 = lens[Math.floor(lens.length / 3)];
  const t2 = lens[Math.floor((2 * lens.length) / 3)];
  const tercile = (u) => {
    const L = (u.text ?? "").length;
    return L <= t1 ? 0 : L <= t2 ? 1 : 2;
  };

  // first categorical metadata column → up to 6 cells (top-5 values + other)
  const { columns } = detect(units.map((u) => u.meta ?? {}));
  const catCol = columns.find((c) => c.role === "categorical")?.name ?? null;
  let cellOf = () => "all";
  if (catCol) {
    const counts = new Map();
    for (const u of units) {
      const v = String(u.meta?.[catCol] ?? "");
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([v]) => v);
    const topSet = new Set(top);
    cellOf = (u) => {
      const v = String(u.meta?.[catCol] ?? "");
      return topSet.has(v) ? v : "__other__";
    };
  }

  // strata → proportional allocation (largest remainder), seeded draw within
  const strata = new Map();
  for (const u of units) {
    const key = `${tercile(u)}|${cellOf(u)}`;
    let s = strata.get(key);
    if (!s) strata.set(key, (s = []));
    s.push(u);
  }
  const entries = [...strata.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = units.length;
  const alloc = entries.map(([key, members]) => {
    const exact = (target * members.length) / total;
    return { key, members, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let assigned = alloc.reduce((n, a) => n + a.base, 0);
  for (const a of [...alloc].sort((x, y) => y.frac - x.frac)) {
    if (assigned >= target) break;
    if (a.base < a.members.length) {
      a.base += 1;
      assigned += 1;
    }
  }
  // fill any residue (strata exhausted) from the largest strata
  for (const a of [...alloc].sort((x, y) => y.members.length - x.members.length)) {
    while (assigned < target && a.base < a.members.length) {
      a.base += 1;
      assigned += 1;
    }
  }

  const sample = [];
  for (const a of alloc) {
    sample.push(...seededSample(a.members, a.base, `brief|${corpusId}|${a.key}`));
  }
  return { sample, strataColumn: catCol, strata: entries.length };
}

// Drop refs that are not ids of units the Director was shown; count the drops.
function filterRefs(refs, validIds, counter) {
  const kept = [];
  for (const r of refs ?? []) {
    if (validIds.has(r)) kept.push(r);
    else counter.n++;
  }
  return kept;
}

// How often the in-flight Director call reports elapsed seconds. ~2s keeps
// the wait readable without chattering; the timer is cleared the moment the
// call settles (resolve or reject), so a failed brief leaves no orphan.
const BRIEF_TICK_MS = 2000;

// generateBrief(project, corpusId, {onParagraph, onStage, signal}) → brief
// artifact. onParagraph(paragraph, index) fires per validated paragraph, in
// order, for SSE relay. onStage(event, data) reports honest progress — only
// stages the server knows to be true, never a fabricated percentage:
//   sampling {sampleN, unitCount}      the stratified sample is drawn
//   prompt-composed {chars}            the prompt is built
//   director-called {provider, model}  the one long call starts
//   tick {elapsed}                     every ~2s while that call is in flight
//   validating {sampleN}               refs checked against the shown sample
//
// signal (optional AbortSignal): a cooperative stop wired to client
// disconnect. The brief is ONE long Director call, so the meaningful place to
// honor it is BEFORE that call — a tab closed during sampling/prompt
// composition must not go on to spend the Director call. (The in-flight call
// itself cannot be cancelled without an abortable callDirector; that is the
// known limit of the cooperative approach and is documented in the route.)
export async function generateBrief(project, corpusId, { onParagraph, onStage, signal } = {}) {
  const stage = (event, data) => {
    onStage?.(event, data);
  };
  const aborted = () => Boolean(signal?.aborted);
  const stopIfAborted = () => {
    if (aborted())
      throw new ConcordError("ABORTED", "brief generation aborted — the client disconnected", {});
  };
  const { meta, units } = await readCorpusUnits(project, corpusId);
  stopIfAborted();
  const target = briefSampleTarget(units.length);
  const { sample, strataColumn, strata } = stratifiedSample(units, corpusId, target);
  const validIds = new Set(sample.map((u) => u.id));
  stage("sampling", { sampleN: sample.length, unitCount: units.length });

  const { columns } = detect(units.map((u) => u.meta ?? {})); // summary for the prompt
  const metaSummary = columns.map((c) => `${c.name} (${c.role})`).join(", ");

  // Scope provenance: which column the unit text came from, and how many
  // metadata columns ride alongside. Old corpora predate the entry fields —
  // fall back to the unitization block, then to detection for the count, and
  // never fabricate a column name.
  const textColumn = meta.textColumn ?? meta.unitization?.textColumn ?? null;
  const metaColumns = typeof meta.metaColumns === "number" ? meta.metaColumns : columns.length;

  const { system, user } = briefPrompt({
    projectName: project.name,
    corpusName: meta.name ?? corpusId,
    unitCount: units.length,
    sample,
    metaSummary,
  });
  // The brief must name its scope: a Director (and a researcher reading over
  // its shoulder) that thinks it is reading descriptions when it is reading
  // titles is the exact field failure this line exists to prevent.
  const scopedUser = textColumn
    ? `Unit text comes from the column '${textColumn}'; ${metaColumns} metadata columns are summarized alongside.\n\n${user}`
    : user;
  stage("prompt-composed", { chars: system.length + scopedUser.length });

  // cooperative abort: the client disconnected before the one paid Director
  // call — stop here rather than spend it (anything already persisted is
  // nothing yet; the brief is written only after the call returns).
  stopIfAborted();
  stage("director-called", {
    provider: project?.director?.provider ?? null,
    model: project?.director?.model ?? null,
  });
  const calledAt = Date.now();
  const ticker = onStage
    ? setInterval(
        () => stage("tick", { elapsed: Math.round((Date.now() - calledAt) / 1000) }),
        BRIEF_TICK_MS,
      )
    : null;
  let res;
  try {
    res = await callDirector(project, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: scopedUser },
      ],
      schema: BRIEF_SCHEMA,
      // The brief is the Director's longest structured output — paragraphs +
      // themes + per-claim unit refs. 4096 truncated in the field (Gemini Flash
      // via OpenRouter); 16384 leaves real-model verbosity room, and a
      // truncation still retries once at 2x inside callDirector.
      maxTokens: 16384,
    });
  } finally {
    // settle = resolve OR reject: a failed call must not leave the interval
    // ticking into a closed stream
    if (ticker) clearInterval(ticker);
  }
  const out = res.json;

  // Evidence validation: every ref must point at a unit the Director saw.
  stage("validating", { sampleN: sample.length });
  const dropped = { n: 0 };
  const paragraphs = (out.paragraphs ?? []).map((p) => ({
    md: p.md,
    refs: filterRefs(p.refs, validIds, dropped),
  }));
  const themes = (out.themes ?? []).map((t) => ({
    name: t.name,
    definition: t.definition,
    quoteRefs: filterRefs(t.quoteRefs, validIds, dropped),
  }));
  const redFlags = (out.redFlags ?? []).map((f) => ({
    kind: f.kind,
    detail: f.detail,
    refs: filterRefs(f.refs, validIds, dropped),
  }));

  const brief = {
    id: newId("brief"),
    corpusId,
    textColumn,
    metaColumns,
    createdAt: new Date().toISOString(),
    authoredBy: "director",
    humanTouched: false,
    unitOfAnalysis: out.unitOfAnalysis,
    paragraphs,
    themes,
    redFlags,
    suggestedQuestions: out.suggestedQuestions ?? [],
    sample: {
      n: sample.length,
      design: "length-terciles × meta cells",
      strataColumn,
      strata,
      unitIds: sample.map((u) => u.id),
    },
    issues: { invalidRefs: dropped.n },
  };

  for (let i = 0; i < paragraphs.length; i++) {
    if (onParagraph) await onParagraph(paragraphs[i], i);
  }

  const pdir = projectDir(project.slug);
  await writeArtifact(pdir, `briefs/${brief.id}.json`, brief);
  await updateProject(project.slug, (p) => {
    p.briefs.push({
      id: brief.id,
      corpusId,
      createdAt: brief.createdAt,
      authoredBy: "director",
      paragraphs: paragraphs.length,
      themes: themes.length,
    });
  });
  await ledger.append(
    pdir,
    "director",
    "brief.generated",
    { briefId: brief.id, corpusId },
    {
      sampleN: sample.length,
      paragraphs: paragraphs.length,
      themes: themes.length,
      redFlags: redFlags.length,
      invalidRefs: dropped.n,
    },
  );
  return brief;
}
