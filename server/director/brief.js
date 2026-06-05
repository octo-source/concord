// The Corpus Brief: the Director's first-read memo over a stratified sample.
// One Director call; every claim carries unit refs that are validated against
// the sample actually shown (invalid refs are dropped and counted as an issue
// — a Director that cites unseen units is exhibiting exactly the failure mode
// the evidence discipline exists to catch). The brief is persisted as
// briefs/<id>.json (authoredBy: "director"), registered on project.briefs,
// and ledgered as `brief.generated` (taxonomy addition approved in review).
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
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v]) => v);
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

// generateBrief(project, corpusId, {onParagraph}) → brief artifact.
// onParagraph(paragraph, index) fires per validated paragraph, in order, for
// SSE relay.
export async function generateBrief(project, corpusId, { onParagraph } = {}) {
  const { meta, units } = await readCorpusUnits(project, corpusId);
  const target = briefSampleTarget(units.length);
  const { sample, strataColumn, strata } = stratifiedSample(units, corpusId, target);
  const validIds = new Set(sample.map((u) => u.id));

  const { columns } = detect(units.map((u) => u.meta ?? {})); // summary for the prompt
  const metaSummary = columns.map((c) => `${c.name} (${c.role})`).join(", ");

  const { system, user } = briefPrompt({
    projectName: project.name,
    corpusName: meta.name ?? corpusId,
    unitCount: units.length,
    sample,
    metaSummary,
  });
  const res = await callDirector(project, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schema: BRIEF_SCHEMA,
    maxTokens: 4096,
  });
  const out = res.json;

  // Evidence validation: every ref must point at a unit the Director saw.
  const dropped = { n: 0 };
  const paragraphs = (out.paragraphs ?? []).map((p) => ({ md: p.md, refs: filterRefs(p.refs, validIds, dropped) }));
  const themes = (out.themes ?? []).map((t) => ({
    name: t.name,
    definition: t.definition,
    quoteRefs: filterRefs(t.quoteRefs, validIds, dropped),
  }));
  const redFlags = (out.redFlags ?? []).map((f) => ({ kind: f.kind, detail: f.detail, refs: filterRefs(f.refs, validIds, dropped) }));

  const brief = {
    id: newId("brief"),
    corpusId,
    createdAt: new Date().toISOString(),
    authoredBy: "director",
    humanTouched: false,
    unitOfAnalysis: out.unitOfAnalysis,
    paragraphs,
    themes,
    redFlags,
    suggestedQuestions: out.suggestedQuestions ?? [],
    sample: { n: sample.length, design: "length-terciles × meta cells", strataColumn, strata, unitIds: sample.map((u) => u.id) },
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
  await ledger.append(pdir, "director", "brief.generated", { briefId: brief.id, corpusId }, {
    sampleN: sample.length,
    paragraphs: paragraphs.length,
    themes: themes.length,
    redFlags: redFlags.length,
    invalidRefs: dropped.n,
  });
  return brief;
}
