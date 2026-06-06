// Project bundle storage. Projects are plain folders under projects/<slug>/
// with project.json + NDJSON append-only files. Crash consistency comes from
// atomic temp-file writes (unique tmp name, fsync, rename — design §4);
// concurrent writers to the same project are serialized through a per-slug
// promise queue. NDJSON reads are streamed so offset/limit reads never buffer
// the whole file. A torn FINAL NDJSON line (file does not end with "\n") means
// the append never durably completed — readers skip it, appenders truncate it.
import { mkdir, open, readFile, rename, readdir, stat, rm, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConcordError } from "./errors.js";
import { rehydrateProject } from "./objects.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export function projectsDir() {
  return process.env.CONCORD_PROJECTS_DIR || path.join(repoRoot, "projects");
}

export function projectDir(slug, dir = projectsDir()) {
  return path.join(dir, slug);
}

// ------------------------------------------------------------ project.json

const projectLocks = new Map(); // resolved project dir -> promise queue

function withProjectLock(key, fn) {
  const prev = projectLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  projectLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

let tmpSeq = 0;

// Windows rename fails EPERM/EBUSY/EACCES when ANOTHER program briefly holds
// the file — Dropbox sync does exactly this to bundles living in a synced
// folder (field report: a goldset save EPERM'd mid-coding). The lock is
// transient; retry with backoff before giving up.
export async function renameWithRetry(from, to, { attempts = 6, baseMs = 40 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (err) {
      const transient = err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES";
      if (!transient || i >= attempts - 1) {
        if (transient) {
          err.message += " — another program (often Dropbox sync) held the file; the action is safe to retry";
        }
        throw err;
      }
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
}

// write tmp (unique name: concurrent writers must never share one), fsync,
// rename — the §4 atomic-write recipe. tmp is removed if the rename fails.
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function loadProject(slug, dir = projectsDir()) {
  const file = path.join(dir, slug, "project.json");
  try {
    return rehydrateProject(JSON.parse(await readFile(file, "utf8")));
  } catch (err) {
    if (err.code === "ENOENT") throw new ConcordError("NOT_FOUND", `Project '${slug}' not found`, { slug });
    if (err instanceof SyntaxError) throw new ConcordError("CORRUPT", `project.json for '${slug}' is not valid JSON`, { slug });
    throw err;
  }
}

async function writeProject(project, dir) {
  const pdir = path.join(dir, project.slug);
  await mkdir(pdir, { recursive: true });
  await writeAtomic(path.join(pdir, "project.json"), JSON.stringify(project, null, 2));
  return project;
}

export async function saveProject(project, dir = projectsDir()) {
  if (!project || typeof project.slug !== "string" || !project.slug) {
    throw new ConcordError("VALIDATION", "saveProject requires a project with a slug", {});
  }
  return withProjectLock(path.resolve(dir, project.slug), () => writeProject(project, dir));
}

// Single-flight read-modify-write: lock -> load -> mutate -> save -> return.
// The mutator may edit in place (return undefined) or return a replacement
// object; either way the slug must stay put. This is the primitive every
// route that touches project.json must use — never load+save by hand.
export async function updateProject(slug, mutatorFn, dir = projectsDir()) {
  return withProjectLock(path.resolve(dir, slug), async () => {
    const project = await loadProject(slug, dir);
    const result = await mutatorFn(project);
    const updated = result === undefined ? project : result;
    if (!updated || updated.slug !== slug) {
      throw new ConcordError("VALIDATION", "updateProject mutator must keep the project slug", { slug });
    }
    return writeProject(updated, dir);
  });
}

// ------------------------------------------------------------------ NDJSON

function badNdjson(file, lineNo) {
  return new ConcordError("BAD_NDJSON", `Malformed NDJSON at line ${lineNo} of ${path.basename(file)}`, { file, line: lineNo });
}

async function endsWithNewline(file) {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

// Scan backward for the last "\n" and truncate just after it (drop the torn
// final line). Returns the new size.
async function truncateTornTail(fh, size) {
  const CHUNK = 64 * 1024;
  const buf = Buffer.alloc(Math.min(CHUNK, size));
  let end = size;
  while (end > 0) {
    const len = Math.min(CHUNK, end);
    const start = end - len;
    await fh.read(buf, 0, len, start);
    const idx = buf.subarray(0, len).lastIndexOf(0x0a);
    if (idx !== -1) {
      const keep = start + idx + 1;
      await fh.truncate(keep);
      return keep;
    }
    end = start;
  }
  await fh.truncate(0);
  return 0;
}

// Append one JSON line. If a previous append was torn (file does not end with
// "\n"), the partial final line never durably completed — truncate it first so
// the file is back to "complete lines only", then append. Returns {size}: the
// file size after the write (the ledger uses it to checkpoint its tail).
export async function appendNdjson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const line = JSON.stringify(obj) + "\n";
  // Heal first with a read-write handle (Windows forbids ftruncate on append-
  // mode handles), then append with O_APPEND semantics so concurrent
  // in-process appends interleave whole lines instead of clobbering offsets.
  let size = 0;
  let fh = null;
  try {
    fh = await open(file, "r+");
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // missing file: appendFile creates it
  }
  if (fh) {
    try {
      ({ size } = await fh.stat());
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) size = await truncateTornTail(fh, size);
      }
    } finally {
      await fh.close();
    }
  }
  await appendFile(file, line, "utf8");
  return { size: size + Buffer.byteLength(line) };
}

// Streamed NDJSON reader. filter applies first, then offset/limit count
// filtered rows; stops reading as soon as `limit` rows are collected.
// A malformed line throws BAD_NDJSON — except a malformed FINAL line in a
// file with no trailing newline, which is a torn append (crash mid-write),
// not corruption: it is skipped, and onTornTail (if given) is told.
export async function readNdjson(file, { offset = 0, limit = Infinity, filter, onTornTail } = {}) {
  if (limit <= 0) return [];
  try {
    await stat(file);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out = [];
  let seen = 0;
  let lineNo = -1;
  let pendingBad = null; // a parse failure that may yet prove to be a torn tail
  try {
    for await (const line of rl) {
      lineNo++;
      if (pendingBad) throw badNdjson(file, pendingBad.lineNo); // lines follow it — mid-file corruption
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        pendingBad = { lineNo, line };
        continue;
      }
      if (filter && !filter(obj)) continue;
      if (seen++ < offset) continue;
      out.push(obj);
      if (out.length >= limit) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (pendingBad) {
    if (await endsWithNewline(file)) throw badNdjson(file, pendingBad.lineNo); // complete line, still garbage
    onTornTail?.(pendingBad.line);
  }
  return out;
}

export async function listProjects(dir = projectsDir()) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      out.push(await loadProject(e.name, dir));
    } catch (err) {
      // no project.json at all -> not a bundle, skip silently; anything else
      // (unparseable JSON, failed rehydration, fs errors) is a damaged bundle
      // the UI must be able to show instead of silently hiding
      if (err?.code !== "NOT_FOUND") out.push({ slug: e.name, corrupt: true });
    }
  }
  return out;
}
