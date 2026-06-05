// Append-only, hash-chained project ledger (ledger.ndjson in the project
// bundle). Every event: {ts, actor, type, refs, payload, prev, hash} with
// hash = sha256(prev + canonical(body)) — so any retroactive edit breaks the
// chain and verify() reports the first bad index.
//
// CONCURRENCY CONTRACT: a project bundle has exactly ONE writing process.
// Appends are serialized in-process by a promise queue; there is no cross-
// process file lock. The --coder profile therefore runs inside the same
// server process (a route gate, not a second writer). As a safety net for
// stale state, append() stats the file and re-reads the tail whenever the
// size on disk does not match its checkpoint.
//
// TORN TAILS: a torn final line (file lacking its trailing "\n") means the
// last append never durably completed — it is NOT corruption. append() heals
// it by truncation (via store.appendNdjson) before chaining; verify() reports
// {ok: true, tornTail: true} over the complete prefix. Mid-file garbage stays
// a hard verify failure.
import path from "node:path";
import { stat } from "node:fs/promises";
import { appendNdjson, readNdjson } from "./store.js";
import { canonical, sha256 } from "./ids.js";

const tails = new Map(); // ledger file -> { hash, size } checkpoint of last append
const locks = new Map(); // ledger file -> append serialization queue

function ledgerFile(projectDir) {
  return path.resolve(projectDir, "ledger.ndjson");
}

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export function append(projectDir, actor, type, refs, payload) {
  const file = ledgerFile(projectDir);
  return withLock(file, async () => {
    let cached = tails.get(file);
    if (cached !== undefined) {
      // distrust the checkpoint unless the file is exactly as we left it
      // (an external append/heal/delete invalidates it — re-read instead)
      try {
        if ((await stat(file)).size !== cached.size) cached = undefined;
      } catch {
        cached = undefined;
      }
    }
    let prev;
    if (cached === undefined) {
      const events = await readNdjson(file); // skips a torn tail; appendNdjson truncates it below
      prev = events.length ? events[events.length - 1].hash : "";
    } else {
      prev = cached.hash;
    }
    // hash-what-you-persist: round-trip through JSON first so values with
    // toJSON (Dates), undefined holes, etc. are hashed exactly as stored
    const body = JSON.parse(JSON.stringify({ ts: new Date().toISOString(), actor, type, refs, payload }));
    const hash = sha256(prev + canonical(body));
    const event = { ...body, prev, hash };
    const { size } = await appendNdjson(file, event);
    tails.set(file, { hash, size });
    return event;
  });
}

export async function verify(projectDir) {
  const file = ledgerFile(projectDir);
  let tornTail = false;
  let events;
  try {
    events = await readNdjson(file, { onTornTail: () => { tornTail = true; } });
  } catch (err) {
    if (err.code === "BAD_NDJSON") return { ok: false, length: err.details.line, failedAt: err.details.line };
    throw err;
  }
  let prev = "";
  for (let i = 0; i < events.length; i++) {
    const { ts, actor, type, refs, payload, prev: storedPrev, hash } = events[i];
    const expected = sha256(prev + canonical({ ts, actor, type, refs, payload }));
    if (storedPrev !== prev || hash !== expected) return { ok: false, length: events.length, failedAt: i };
    prev = hash;
  }
  return tornTail ? { ok: true, length: events.length, tornTail: true } : { ok: true, length: events.length };
}

function hasRef(refs, ref) {
  if (Array.isArray(refs)) return refs.includes(ref);
  if (refs && typeof refs === "object") return Object.values(refs).includes(ref);
  return refs === ref;
}

export function query(projectDir, { type, ref } = {}) {
  return readNdjson(ledgerFile(projectDir), {
    filter: (e) => (type === undefined || e.type === type) && (ref === undefined || hasRef(e.refs, ref)),
  });
}
