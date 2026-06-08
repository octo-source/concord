// Two-step corpus import.
//
// POST /import        multipart upload → parse by extension → mapping proposal
//                     + preview; the PARSED rows persist to
//                     projects/<slug>/.imports/<importId>.json (no corpus yet,
//                     nothing ledgered — nothing happened to the project until
//                     the researcher confirms the mapping).
// POST /import/confirm {importId, mapping: {textColumn?, columns?: [{name,
//                     role}]}, unitization, pii?} → unitize (columns with
//                     role "ignore" are dropped from unit.meta HERE, before
//                     the pii step — never scanned, masked, prompted or
//                     exported) → PII step ("off" | "scan" | "pseudonymize",
//                     default "scan"; pseudonymize masks identifiers BEFORE
//                     anything persists, vault at
//                     projects/<slug>/vault/<corpusId>.json) → junk scan →
//                     corpus meta (incl. columnRoles when roles were sent) +
//                     units.ndjson → ledger corpus.imported +
//                     corpus.unitized (+ pii.pseudonymized) → temp deleted.
//                     Response carries skipped: tabular rows whose
//                     text-column cell was empty (silently dropped at
//                     unitize); 0 for doc/turn sources.
import path from "node:path";
import { mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { parseMultipart } from "../router.js";
import { newId } from "../core/ids.js";
import { loadProject, updateProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { detect, bestTextColumn } from "../ingest/mapping.js";
import { unitize } from "../ingest/unitize.js";
import { scan as junkScan } from "../ingest/junk.js";
import { scan as piiScan, pseudonymize } from "../ingest/pii.js";
import { pdirOf, writeJsonAtomic, writeTextAtomic, readJsonFile, corpusUnitsFile, safeId } from "./_shared.js";

const PARSERS = {
  ".csv": { mod: "../ingest/csv.js", format: "csv" },
  ".tsv": { mod: "../ingest/csv.js", format: "tsv", opts: { delimiter: "\t" } },
  ".xlsx": { mod: "../ingest/xlsx.js", format: "xlsx" },
  ".xls": { mod: "../ingest/xlsx.js", format: "xlsx" },
  ".docx": { mod: "../ingest/docx.js", format: "docx" },
  ".pdf": { mod: "../ingest/pdf.js", format: "pdf" },
  ".txt": { mod: "../ingest/text.js", format: "text" },
  ".md": { mod: "../ingest/text.js", format: "text" },
  ".html": { mod: "../ingest/text.js", format: "html" },
  ".vtt": { mod: "../ingest/transcript.js", format: "vtt" },
  ".srt": { mod: "../ingest/transcript.js", format: "srt" },
  ".json": { mod: "../ingest/transcript.js", format: "transcript-json" },
};

function importsDir(slug) {
  return path.join(pdirOf(slug), ".imports");
}

function previewOf(parsed) {
  if (Array.isArray(parsed.rows)) return parsed.rows.slice(0, 20);
  if (Array.isArray(parsed.docs)) {
    return parsed.docs
      .flatMap((d) => d.paras.map((text, i) => ({ doc: d.name, para: i, text })))
      .slice(0, 20);
  }
  if (Array.isArray(parsed.turns)) return parsed.turns.slice(0, 20);
  return [];
}

// The column actually carrying unit text, resolved with the same preference
// order unitize applies (explicit choice → mapping detection → longest mean
// length). Resolved BEFORE unitize and passed in, so what the corpus entry
// records can never diverge from what unitization used. Non-tabular parses
// (docs/turns) have no text column → null.
function resolveTextColumn(parsed, requested) {
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) return null;
  if (requested) return requested;
  const best = bestTextColumn(parsed.rows);
  if (best) return best;
  // mirror unitize's fallback: longest mean-length column wins
  let bestName = null;
  let bestLen = -1;
  for (const name of Object.keys(parsed.rows[0])) {
    if (name.startsWith("__")) continue;
    let sum = 0;
    for (const r of parsed.rows) sum += String(r[name] ?? "").length;
    if (sum / parsed.rows.length > bestLen) {
      bestLen = sum / parsed.rows.length;
      bestName = name;
    }
  }
  return bestName;
}

// Number of distinct metadata keys across a corpus's units (scope provenance).
export function metaColumnsOf(units) {
  const keys = new Set();
  for (const u of units) for (const k of Object.keys(u.meta ?? {})) keys.add(k);
  return keys.size;
}

// What happens to identifiers (emails, phones, names…) at confirm. "scan"
// is the default: counting and flagging costs nothing and the researcher
// keeps the original text; "pseudonymize" is the only mode that rewrites it.
const PII_MODES = new Set(["off", "scan", "pseudonymize"]);

async function latestImportId(slug) {
  let entries;
  try {
    entries = await readdir(importsDir(slug));
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries.filter((f) => f.endsWith(".json"))) {
    const s = await stat(path.join(importsDir(slug), name));
    if (!best || s.mtimeMs > best.mtime) best = { id: name.slice(0, -5), mtime: s.mtimeMs };
  }
  return best?.id ?? null;
}

export default [
  {
    method: "POST",
    pattern: "/api/projects/:p/import",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const { files } = await parseMultipart(req);
      const file = files.find((f) => f.name === "file") ?? files[0];
      if (!file || !file.buffer?.length) {
        throw new ConcordError("VALIDATION", "import requires one uploaded file (multipart field \"file\")", {});
      }
      const ext = path.extname(file.filename ?? "").toLowerCase();
      const spec = PARSERS[ext];
      if (!spec) {
        throw new ConcordError("VALIDATION", `unsupported file type "${ext}" — supported: ${Object.keys(PARSERS).join(" ")}`, { ext });
      }

      // parsers take file paths: stage the upload inside the bundle's .imports
      const importId = newId("imp");
      const dir = importsDir(project.slug);
      await mkdir(dir, { recursive: true });
      const srcPath = path.join(dir, `${importId}${ext}`);
      await writeFile(srcPath, file.buffer);
      let parsed;
      try {
        const mod = await import(spec.mod);
        parsed = await mod.parse(srcPath, spec.opts ?? {});
      } finally {
        await rm(srcPath, { force: true }).catch(() => {});
      }

      const issues = parsed.issues ?? [];
      const mapping = Array.isArray(parsed.rows) && parsed.rows.length > 0 ? detect(parsed.rows) : null;
      const record = {
        importId,
        filename: file.filename ?? `upload${ext}`,
        format: spec.format,
        createdAt: new Date().toISOString(),
        parsed: {
          ...(parsed.rows !== undefined ? { rows: parsed.rows } : {}),
          ...(parsed.docs !== undefined ? { docs: parsed.docs } : {}),
          ...(parsed.turns !== undefined ? { turns: parsed.turns } : {}),
        },
        issues,
      };
      await writeJsonAtomic(path.join(dir, `${importId}.json`), record);
      return { importId, mapping, preview: previewOf(parsed), issues };
    },
  },
  {
    method: "POST",
    pattern: "/api/projects/:p/import/confirm",
    handler: async (req, res, params) => {
      const project = await loadProject(params.p);
      const body = req.body ?? {};
      const piiMode = body.pii === undefined ? "scan" : body.pii;
      if (!PII_MODES.has(piiMode)) {
        throw new ConcordError("VALIDATION", `pii must be "off", "scan" or "pseudonymize" (got ${JSON.stringify(body.pii)})`, { pii: body.pii });
      }
      // the UI wrapper omits importId — fall back to the most recent upload
      const importId = body.importId ?? (await latestImportId(project.slug));
      if (!importId) {
        throw new ConcordError("VALIDATION", "no pending import to confirm — upload a file first", {});
      }
      safeId(importId, "importId"); // never let a traversal id reach the read/rm path
      const record = await readJsonFile(path.join(importsDir(project.slug), `${importId}.json`));
      if (!record) {
        throw new ConcordError("NOT_FOUND", `pending import '${importId}' not found (already confirmed?)`, { importId });
      }
      const parsed = record.parsed;
      const scheme = body.unitization?.scheme
        ?? (parsed.rows ? "response" : parsed.docs ? "paragraph" : "turn");
      const requestedTextColumn = body.mapping?.textColumn
        ?? (body.mapping?.columns ?? []).find((c) => c.role === "text")?.name;
      const textColumn = resolveTextColumn(parsed, requestedTextColumn);

      // Column roles from the import sheet (mapping.columns [{name, role}]).
      // "ignore" drops the column from unit.meta at unitize — BEFORE the pii
      // step, so ignored values are never scanned, never masked, and never
      // reach Director prompts or the replication units CSV (unit.meta is the
      // only carrier for all three). The explicit unit-text choice wins over
      // a contradictory ignore. The full map persists on the corpus entry as
      // columnRoles — NOT corpus.columns, which GET /corpora/:c/columns
      // already uses as its cache key.
      const columnRoles = Array.isArray(body.mapping?.columns)
        ? body.mapping.columns
            .filter((c) => c && typeof c.name === "string" && c.name !== "" && typeof c.role === "string")
            .map((c) => ({ name: c.name, role: c.role }))
        : [];
      const ignoreColumns = columnRoles
        .filter((c) => c.role === "ignore" && c.name !== textColumn)
        .map((c) => c.name);

      const corpusId = newId("corp");
      let units = unitize(corpusId, parsed, scheme, {
        ...(textColumn ? { textColumn } : {}),
        ...(ignoreColumns.length ? { ignoreColumns } : {}),
      });
      if (units.length === 0) {
        throw new ConcordError("VALIDATION", "unitization produced no units — check the text column and scheme", { scheme, textColumn });
      }

      // Rows unitize silently dropped because the text-column cell was empty.
      // Only well-defined for tabular sources (every non-empty row yields at
      // least one unit under both response and sentence schemes); doc/turn
      // sources report 0 rather than a guess.
      let skipped = 0;
      if (Array.isArray(parsed.rows) && textColumn) {
        for (const r of parsed.rows) {
          if (!String(r[textColumn] ?? "").trim()) skipped += 1;
        }
      }

      // PII step — AFTER unitize, BEFORE the junk scan, so masking happens
      // before any unit text persists or reaches a model provider. "scan"
      // counts and flags in place; "pseudonymize" REPLACES the unit array
      // with the masked copies and writes the reversible token map to
      // projects/<slug>/vault/<corpusId>.json. That vault is the
      // re-identification key: it must never enter the replication archive
      // (which builds from an explicit member allowlist) or any other export.
      let pii = { mode: piiMode };
      let piiVault = null;
      if (piiMode === "scan") {
        const { counts } = piiScan(units); // mutates unit.flags.pii in place
        pii = { mode: "scan", counts };
      } else if (piiMode === "pseudonymize") {
        const vaultPath = path.join(pdirOf(project.slug), "vault", `${corpusId}.json`);
        const masked = await pseudonymize(units, vaultPath); // creates the vault dir + file
        units = masked.units; // the MASKED units are what persists and counts downstream
        piiVault = masked.vault;
        pii = { mode: "pseudonymize", counts: masked.vault.counts };
      }

      const junk = junkScan(units); // mutates unit.flags in place

      await writeTextAtomic(
        corpusUnitsFile(project.slug, corpusId),
        units.map((u) => JSON.stringify(u)).join("\n") + "\n",
      );

      const rows = parsed.rows?.length;
      const meta = {
        id: corpusId,
        name: body.name ?? record.filename,
        source: { filename: record.filename, format: record.format, ...(rows !== undefined ? { rows } : {}) },
        unitization: { scheme, ...(textColumn ? { textColumn } : {}) },
        unitCount: units.length,
        createdAt: new Date().toISOString(),
        // Scope provenance (field gap: a 60-column XLSX landed unitization on
        // the TITLE column and nothing downstream said so). Every corpus entry
        // records WHICH column became unit text and what rode along; readers
        // must tolerate nulls on corpora created before these fields existed.
        textColumn: textColumn ?? null,
        scheme,
        junk: junk.counts,
        // what happened to identifiers at import: {mode} for "off",
        // {mode, counts} for "scan"/"pseudonymize"
        pii,
        metaColumns: metaColumnsOf(units),
        // the confirmed role map, for provenance/display — ignored columns
        // are physically absent from the units above
        ...(columnRoles.length ? { columnRoles } : {}),
        sourceName: record.filename ?? null,
      };
      await updateProject(project.slug, (p) => {
        p.corpora.push(meta);
      });
      const pdir = pdirOf(project.slug);
      await ledger.append(pdir, "human", "corpus.imported", { corpusId }, {
        filename: record.filename,
        format: record.format,
        ...(rows !== undefined ? { rows } : {}),
        pii,
      });
      await ledger.append(pdir, "human", "corpus.unitized", { corpusId }, {
        scheme,
        unitCount: units.length,
        junk: junk.counts,
      });
      if (piiMode === "pseudonymize") {
        // the taxonomy's reserved event for exactly this wiring
        await ledger.append(pdir, "human", "pii.pseudonymized", { corpusId }, {
          counts: piiVault.counts,
          tokenCount: piiVault.tokenCount,
        });
      }
      await rm(path.join(importsDir(project.slug), `${importId}.json`), { force: true }).catch(() => {});

      return {
        corpusId,
        unitCount: units.length,
        skipped,
        junkQueue: { counts: junk.counts, flagged: junk.flagged.slice(0, 100) },
        pii,
      };
    },
  },
];
