// Content-addressed output cache: a worker call is keyed by
// sha256(unitText | instrument versionHash | model snapshot), so reruns and
// resumed runs hit the cache instead of the provider. Stored as JSON files
// under <projectDir>/cache/<first2>/<rest> (git-style fan-out).
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { renameWithRetry } from "./store.js";
import path from "node:path";
import { sha256 } from "./ids.js";

export function key(unitText, versionHash, snapshot) {
  return sha256(`${unitText}|${versionHash}|${snapshot}`);
}

function entryPath(projectDir, k) {
  return path.join(projectDir, "cache", k.slice(0, 2), k.slice(2));
}

export async function get(projectDir, k) {
  try {
    return JSON.parse(await readFile(entryPath(projectDir, k), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null; // torn write — treat as miss
    throw err;
  }
}

let tmpSeq = 0;

export async function put(projectDir, k, value) {
  const file = entryPath(projectDir, k);
  await mkdir(path.dirname(file), { recursive: true });
  // unique tmp name: concurrent puts of the same key (duplicate unit texts in
  // a parallel run) must not collide mid-rename
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    // either we lost a same-key race (identical content already landed) or
    // the rename genuinely failed — in both cases the tmp must not linger
    let existing = null;
    try { existing = await get(projectDir, k); } catch { /* unreadable -> treat as missing */ }
    await rm(tmp, { force: true }).catch(() => {});
    if (existing === null) throw err;
  }
  return value;
}
