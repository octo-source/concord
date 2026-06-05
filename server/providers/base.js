// Provider layer foundation: the Adapter contract every backend implements,
// the per-provider Pool (concurrency + rpm + retry), the shared HTTP helper,
// and schema validation / constrained-repair used by all structured output.
import { ConcordError } from "../core/errors.js";

export class Adapter {
  // cfg: {apiKey?, baseUrl?, name}
  constructor(cfg = {}) {
    this.name = cfg.name ?? "adapter";
    this.apiKey = cfg.apiKey ?? null;
    this.baseUrl = cfg.baseUrl ? String(cfg.baseUrl).replace(/\/+$/, "") : null;
  }

  // req: {model, messages:[{role,content}], schema?, temperature, maxTokens, seed?}
  // → {text?, json?, usage:{inputTokens,outputTokens}, finishReason, raw, servedBy?}
  async complete() {
    throw new ConcordError("CONFIG_MISSING", `${this.name}: complete() not implemented`);
  }

  capabilities() {
    return { structuredOutput: false, pinning: false, batch: false, local: false, family: this.name };
  }

  // → [{id, name, family, ctx, pricing:{inUSDper1M, outUSDper1M}, snapshot}]
  async catalog() {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry-After is clamped to 120s: a server asking for longer is effectively
// down, and an unbounded server-directed sleep would silently wedge an
// overnight run on a single response header.
const RETRY_AFTER_CAP_MS = 120_000;

export function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1000), RETRY_AFTER_CAP_MS);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_CAP_MS);
}

// Shared fetch wrapper. Non-2xx → ConcordError("PROVIDER_HTTP") carrying
// {status, body, retryAfterMs} so the Pool can decide retryability.
// Network-level failures → ConcordError("PROVIDER_UNREACHABLE") with
// {url, kind} (kind = AbortError for timeouts, TypeError for connection
// faults) and the original error as cause.
//
// The abort timer must outlive the headers phase: fetch resolves at headers,
// but a stalled or severed body would otherwise wedge a Pool slot until the
// socket dies (~minutes) and body-read failures would escape the taxonomy as
// raw TypeErrors. So the timer is cleared in a finally around the WHOLE
// request + body read.
export async function httpJSON(method, url, { headers = {}, body, timeoutMs = 120_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ConcordError("PROVIDER_UNREACHABLE", `request to ${url} failed: ${err?.message ?? err}`, { url, kind: err?.name }, { cause: err });
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw new ConcordError("PROVIDER_UNREACHABLE", `reading response body from ${url} failed: ${err?.message ?? err}`, { url, kind: err?.name }, { cause: err });
    }
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw new ConcordError("PROVIDER_HTTP", `${method} ${url} → HTTP ${res.status}`, {
        status: res.status,
        body: data,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// A 2xx whose body lacks the provider's expected envelope (empty body, HTML
// from a proxy, ...) is a provider fault, not a Concord bug: adapters surface
// it as PROVIDER_HTTP with a body snippet instead of letting property reads
// throw raw TypeErrors.
export function malformedResponse(provider, raw) {
  let snippet;
  try { snippet = typeof raw === "string" ? raw : JSON.stringify(raw); } catch { snippet = String(raw); }
  snippet = String(snippet ?? raw).slice(0, 200);
  return new ConcordError("PROVIDER_HTTP", `malformed response from ${provider}: expected envelope missing`, { provider, body: snippet });
}

// Retry policy (controller decision):
//   - 429 / 5xx → retryable, full budget (maxAttempts, default 6): rate
//     limits and transient server faults are expected during long runs and
//     the server is telling us to come back.
//   - PROVIDER_UNREACHABLE → retryable on a SMALLER budget (3 attempts):
//     judge calls are idempotent and transient network blips are the most
//     common overnight failure, so giving up after one try strands runs —
//     but a host that is truly down should fail fast rather than burn the
//     full 6-attempt backoff ladder. Timeouts vs connection failures stay
//     distinguishable downstream via details.kind.
//   - everything else (4xx, CONFIG_MISSING, SCHEMA_INVALID, ...) → not
//     retryable: retrying a deterministic failure only adds latency.
const UNREACHABLE_MAX_ATTEMPTS = 3;

const retryClass = (err) => {
  const status = err?.details?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) return "http";
  if (err?.code === "PROVIDER_UNREACHABLE") return "unreachable";
  return null;
};

// Per-provider execution pool: bounded concurrency, requests-per-window
// pacing, exponential backoff with jitter. Budgets per retryClass above:
// max 6 attempts for 429/5xx, max 3 for PROVIDER_UNREACHABLE.
export class Pool {
  constructor({ concurrency = 4, rpm = 0, baseDelayMs = 250, maxAttempts = 6, windowMs = 60_000 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.rpm = rpm || 0;
    this.baseDelayMs = baseDelayMs;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.active = 0;
    this.waiters = [];
    this.starts = [];
  }

  async run(fn) {
    await this.#acquire();
    try {
      return await this.#withRetry(fn);
    } finally {
      this.#release();
    }
  }

  async #withRetry(fn) {
    let lastErr = null;
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) await sleep(this.#delayBefore(attempt, lastErr));
      await this.#rpmGate();
      try {
        return await fn();
      } catch (err) {
        const cls = retryClass(err);
        if (!cls) throw err;
        lastErr = err;
        const budget = cls === "unreachable" ? Math.min(UNREACHABLE_MAX_ATTEMPTS, this.maxAttempts) : this.maxAttempts;
        if (attempt >= budget) {
          // Unreachable keeps its identity (callers branch on the code and
          // details.kind); HTTP exhaustion keeps the historical shape.
          if (cls === "unreachable") throw err;
          throw new ConcordError(
            "RATE_LIMITED_EXHAUSTED",
            `gave up after ${attempt} attempts (last: HTTP ${err?.details?.status})`,
            { attempts: attempt, lastStatus: err?.details?.status, lastMessage: err?.message },
          );
        }
      }
    }
  }

  // Backoff doubles per retry; ≤25% jitter keeps successive delays strictly
  // increasing. A server Retry-After is honored as a floor, but capped at
  // RETRY_AFTER_CAP_MS (parseRetryAfter already clamps; this re-clamp guards
  // hand-constructed errors).
  #delayBefore(attempt, err) {
    const backoff = this.baseDelayMs * 2 ** (attempt - 2) * (1 + Math.random() * 0.25);
    const retryAfter = err?.details?.retryAfterMs;
    if (retryAfter == null) return backoff;
    return Math.max(Math.min(retryAfter, RETRY_AFTER_CAP_MS), backoff);
  }

  #acquire() {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  #release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  async #rpmGate() {
    if (!this.rpm) return;
    for (;;) {
      const now = Date.now();
      this.starts = this.starts.filter((t) => now - t < this.windowMs);
      if (this.starts.length < this.rpm) {
        this.starts.push(now);
        return;
      }
      await sleep(this.starts[0] + this.windowMs - now + 1);
    }
  }
}

// Minimal JSON-schema validator covering the shapes Concord emits (type,
// enum, required, properties, items, min/max, additionalProperties:false).
// Returns a list of problems; empty list = valid.
export function validateSchema(value, schema, path = "$") {
  const problems = [];
  if (!schema || typeof schema !== "object") return problems;
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} not in enum [${schema.enum.join(", ")}]`);
  }
  // Director-generated schemas may omit `type`; `properties` implies object.
  const declared = schema.type ? [].concat(schema.type) : [];
  const types = declared.length ? declared : schema.properties ? ["object"] : [];
  if (types.length && !types.some((t) => typeMatches(value, t))) {
    problems.push(`${path}: expected ${types.join("|")}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
    return problems; // wrong type → deeper checks are noise
  }
  if (types.includes("object") && value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) problems.push(`${path}.${key}: missing required property`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) problems.push(...validateSchema(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) problems.push(`${path}.${key}: unexpected property`);
      }
    }
  }
  if (types.includes("array") && Array.isArray(value) && schema.items) {
    value.forEach((v, i) => problems.push(...validateSchema(v, schema.items, `${path}[${i}]`)));
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) problems.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) problems.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  return problems;
}

function typeMatches(value, type) {
  switch (type) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

// Lenient extraction: adapters may return json directly, or text that is JSON,
// fenced JSON, or prose-wrapped JSON.
function extractCandidate(res) {
  if (res.json !== undefined) return { value: res.json, found: true };
  let text = typeof res.text === "string" ? res.text.trim() : "";
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return { value: JSON.parse(text), found: true }; } catch { /* fall through */ }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return { value: JSON.parse(text.slice(first, last + 1)), found: true }; } catch { /* fall through */ }
  }
  return { value: undefined, found: false };
}

const textOf = (res) => (typeof res?.text === "string" ? res.text : res?.json !== undefined ? JSON.stringify(res.json) : "");

// Structured-output enforcement shared by every adapter: validate, then up to
// `maxRepairs` constrained re-prompts, then SCHEMA_INVALID (caller quarantines
// the unit — never silently dropped).
export async function completeWithRepair(adapter, req, { maxRepairs = 2 } = {}) {
  if (!req.schema) return adapter.complete(req);
  let messages = req.messages;
  let last = null;
  let problems = [];
  for (let i = 0; i <= maxRepairs; i++) {
    if (i > 0) {
      messages = [
        ...messages,
        { role: "assistant", content: textOf(last) },
        {
          role: "user",
          content:
            "Your previous response was not valid JSON for the required schema. " +
            `Problems: ${problems.join("; ")}. ` +
            "Respond with ONLY a single JSON object matching this schema, no prose, no code fences:\n" +
            JSON.stringify(req.schema),
        },
      ];
    }
    const res = await adapter.complete({ ...req, messages });
    const { value, found } = extractCandidate(res);
    problems = found ? validateSchema(value, req.schema) : ["response is not parseable JSON"];
    if (problems.length === 0) return { ...res, json: value, repairs: i };
    last = res;
  }
  throw new ConcordError("SCHEMA_INVALID", `response failed schema validation after ${maxRepairs} repair attempt(s)`, {
    problems,
    lastText: textOf(last),
  });
}
