// Append-only, hash-chained project ledger (ledger.ndjson in the project
// bundle). Every event: {ts, actor, type, refs, payload, prev, hash} with
// hash = sha256(prev + canonical(body)) — so any retroactive edit breaks the
// chain and verify() reports the first bad index.
import path from "node:path";
import { appendNdjson, readNdjson } from "./store.js";
import { canonical, sha256 } from "./ids.js";

const tails = new Map(); // ledger file -> hash of last event (per-process cache)
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
    let prev = tails.get(file);
    if (prev === undefined) {
      const events = await readNdjson(file);
      prev = events.length ? events[events.length - 1].hash : "";
    }
    const body = { ts: new Date().toISOString(), actor, type, refs, payload };
    const hash = sha256(prev + canonical(body));
    const event = { ...body, prev, hash };
    await appendNdjson(file, event);
    tails.set(file, hash);
    return event;
  });
}

export async function verify(projectDir) {
  const file = ledgerFile(projectDir);
  let events;
  try {
    events = await readNdjson(file);
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
  return { ok: true, length: events.length };
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
