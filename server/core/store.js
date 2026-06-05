// Project bundle storage. Projects are plain folders under projects/<slug>/
// with project.json + NDJSON append-only files. Crash consistency comes from
// atomic temp-file renames; NDJSON reads are streamed so offset/limit reads
// never buffer the whole file.
import { mkdir, readFile, writeFile, rename, readdir, appendFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConcordError } from "./errors.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export function projectsDir() {
  return process.env.CONCORD_PROJECTS_DIR || path.join(repoRoot, "projects");
}

export function projectDir(slug, dir = projectsDir()) {
  return path.join(dir, slug);
}

export async function loadProject(slug, dir = projectsDir()) {
  const file = path.join(dir, slug, "project.json");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") throw new ConcordError("NOT_FOUND", `Project '${slug}' not found`, { slug });
    if (err instanceof SyntaxError) throw new ConcordError("CORRUPT", `project.json for '${slug}' is not valid JSON`, { slug });
    throw err;
  }
}

export async function saveProject(project, dir = projectsDir()) {
  if (!project || typeof project.slug !== "string" || !project.slug) {
    throw new ConcordError("VALIDATION", "saveProject requires a project with a slug", {});
  }
  const pdir = path.join(dir, project.slug);
  await mkdir(pdir, { recursive: true });
  const file = path.join(pdir, "project.json");
  await writeFile(file + ".tmp", JSON.stringify(project, null, 2), "utf8");
  await rename(file + ".tmp", file); // atomic on the same volume
  return project;
}

export async function appendNdjson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(obj) + "\n", "utf8");
}

// Streamed NDJSON reader. filter applies first, then offset/limit count
// filtered rows; stops reading as soon as `limit` rows are collected.
export async function readNdjson(file, { offset = 0, limit = Infinity, filter } = {}) {
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
  try {
    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        throw new ConcordError("BAD_NDJSON", `Malformed NDJSON at line ${lineNo} of ${path.basename(file)}`, { file, line: lineNo });
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
    } catch {
      // not a project bundle (no/corrupt project.json) — skip
    }
  }
  return out;
}
