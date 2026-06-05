// Construct drafting, legacy codebook import, inductive taxonomy.
//
// Everything here returns PROPOSALS — director-authored Construct objects (or
// a taxonomy artifact) that are NOT persisted. Persistence happens only via
// the explicit acceptConstructs() helper, which routes call when the human
// accepts: it pushes onto project.constructs and ledgers `construct.created`
// per accepted construct.
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { createConstruct } from "../core/objects.js";
import { updateProject, projectDir } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { callDirector, readCorpusUnits, seededSample } from "./director.js";
import {
  constructDraftPrompt, codebookImportPrompt, inductivePrompt,
  CONSTRUCTS_SCHEMA, TAXONOMY_SCHEMA,
} from "./prompts.js";

// Director construct entry → validated Construct object (proposal).
function toConstruct(entry) {
  return createConstruct({
    name: entry.name,
    type: entry.type,
    definition: entry.definition,
    criteria: entry.criteria,
    edgeCases: entry.edgeCases,
    examples: entry.examples,
    ...(entry.categories !== undefined ? { categories: entry.categories } : {}),
    ...(entry.scale !== undefined ? { scale: entry.scale } : {}),
    authoredBy: "director",
    humanTouched: false,
  });
}

// draftConstructs(project, themesOrQuestion, sampleUnits) → Construct[]
// themesOrQuestion: array of theme names/{name, definition} (e.g. accepted
// from a brief) or a plain-language question string.
export async function draftConstructs(project, themesOrQuestion, sampleUnits) {
  if (!Array.isArray(sampleUnits) || sampleUnits.length === 0) {
    throw new ConcordError("VALIDATION", "draftConstructs needs sample units to mine worked examples from", {});
  }
  const { system, user } = constructDraftPrompt({
    themesOrQuestion,
    sampleUnits,
    existingConstructNames: (project.constructs ?? []).map((c) => c.name),
  });
  const res = await callDirector(project, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    schema: CONSTRUCTS_SCHEMA,
    maxTokens: 4096,
  });
  return res.json.constructs.map(toConstruct);
}

// importCodebook(project, fileBuffer, kind) → proposed Construct[]
// kind: "docx" | "pdf". Parsing goes through the Wave-1 ingest modules (they
// take file paths, so the buffer lands in an OS temp file for the duration).
export async function importCodebook(project, fileBuffer, kind) {
  if (kind !== "docx" && kind !== "pdf") {
    throw new ConcordError("VALIDATION", `codebook import supports "docx" or "pdf", got "${kind}"`, { kind });
  }
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new ConcordError("VALIDATION", "codebook import received an empty file", {});
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "concord-codebook-"));
  const file = path.join(dir, `codebook.${kind}`);
  let docText;
  try {
    await writeFile(file, fileBuffer);
    const parser = kind === "docx" ? await import("../ingest/docx.js") : await import("../ingest/pdf.js");
    const { docs } = await parser.parse(file);
    docText = (docs ?? []).flatMap((d) => d.paras).join("\n\n");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (!docText.trim()) {
    throw new ConcordError("VALIDATION", "the codebook document contains no extractable text", { kind });
  }
  const { system, user } = codebookImportPrompt({ docText, fileName: null });
  const res = await callDirector(project, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    schema: CONSTRUCTS_SCHEMA,
    maxTokens: 4096,
  });
  return res.json.constructs.map(toConstruct);
}

// inductiveTaxonomy(project, corpusId, {n}) → taxonomy artifact, explicitly
// framed as hypothesis generation (mode: "inductive-hypothesis"). Quote refs
// are validated against the sampled units; invalid refs are dropped and
// counted.
export async function inductiveTaxonomy(project, corpusId, { n = 300 } = {}) {
  const { units } = await readCorpusUnits(project, corpusId);
  const sample = seededSample(units, Math.min(n, units.length), `inductive|${corpusId}|${n}`);
  const validIds = new Set(sample.map((u) => u.id));

  const { system, user } = inductivePrompt({ sampleUnits: sample });
  const res = await callDirector(project, {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    schema: TAXONOMY_SCHEMA,
    maxTokens: 4096,
  });

  let invalid = 0;
  const themes = res.json.themes.map((t) => {
    const quoteRefs = (t.quoteRefs ?? []).filter((r) => {
      if (validIds.has(r)) return true;
      invalid++;
      return false;
    });
    return { name: t.name, definition: t.definition, quoteRefs };
  });
  return {
    mode: "inductive-hypothesis",
    corpusId,
    sampleN: sample.length,
    themes,
    note: res.json.note ?? "",
    issues: { invalidRefs: invalid },
    authoredBy: "director",
    humanTouched: false,
    createdAt: new Date().toISOString(),
  };
}

// acceptConstructs(project, constructs) → constructId[]
// The explicit persistence step: pushes proposals onto project.constructs and
// ledgers construct.created per construct. Actor is "human" — acceptance is a
// human act even when the artifact is director-authored (the payload records
// authorship).
export async function acceptConstructs(project, constructs) {
  if (!Array.isArray(constructs) || constructs.length === 0) {
    throw new ConcordError("VALIDATION", "acceptConstructs needs at least one construct", {});
  }
  const validated = constructs.map((c) => createConstruct(c));
  await updateProject(project.slug, (p) => {
    for (const c of validated) {
      if (p.constructs.some((existing) => existing.id === c.id)) {
        throw new ConcordError("VALIDATION", `construct ${c.id} already exists on the project`, { constructId: c.id });
      }
      p.constructs.push(c);
    }
  });
  const pdir = projectDir(project.slug);
  for (const c of validated) {
    await ledger.append(pdir, "human", "construct.created", { constructId: c.id }, {
      name: c.name,
      type: c.type,
      authoredBy: c.authoredBy,
    });
  }
  return validated.map((c) => c.id);
}
