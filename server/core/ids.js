import { createHash, randomBytes } from "node:crypto";

// Canonical JSON: recursively sorted object keys, no whitespace, JSON value
// semantics (undefined-valued keys dropped, toJSON honored — so a Date
// canonicalizes to its ISO string exactly as JSON.stringify would persist it).
// Hashing canonical(obj) gives a stable content address regardless of key
// insertion order.
export function canonical(value) {
  if (value !== null && typeof value === "object" && typeof value.toJSON === "function") {
    return canonical(value.toJSON());
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v === undefined ? null : v)).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

export function sha256(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

// Sortable-ish opaque id: timestamp base36 + random base36.
export function newId(prefix) {
  const t = Date.now().toString(36);
  const r = BigInt("0x" + randomBytes(6).toString("hex")).toString(36).padStart(10, "0").slice(0, 10);
  return `${prefix}_${t}${r}`;
}

// Deterministic unit id: stable across re-imports of identical data.
export function unitId(corpusId, rowIndex, text) {
  return "u_" + sha256(`${corpusId}|${rowIndex}|${text}`).slice(0, 16);
}
