// MockModel: fully deterministic provider that lets the whole product run
// keyless (demo, CI, e2e). Seeded by sha256(model + last user message +
// (req.seed ?? "")), so the same request always yields the byte-identical
// response while distinct req.seed values decorrelate it (keyless stability
// checks must not be vacuously α=1.0). Emulates a judge of configurable
// accuracy against an injectable oracle, and exposes a handler hook so later
// workstreams can script Director behavior. Always $0.
import { Adapter } from "./base.js";
import { sha256 } from "../core/ids.js";
import { mulberry32 } from "../core/rng.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RATIONALE_TEMPLATES = [
  (s, l) => `The response mentions "${s}", which points toward ${l}.`,
  (s, l) => `Phrasing like "${s}" is characteristic of ${l}.`,
  (s, l) => `The unit's reference to "${s}" supports reading it as ${l}.`,
  (s, l) => `Taken together with "${s}", the unit reads as ${l}.`,
];

const PROSE_OPENERS = [
  "Across the sampled units,",
  "Reading this data,",
  "A recurring pattern:",
  "The sample suggests that",
];

function extractUnit(text) {
  const m = String(text).match(/<unit>([\s\S]*?)<\/unit>/);
  return m ? m[1].trim() : String(text);
}

// Seeded word-window snippet of the unit text (3–5 words).
function snippetOf(text, rand) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "…";
  const len = Math.min(words.length, 3 + Math.floor(rand() * 3));
  const start = Math.floor(rand() * Math.max(1, words.length - len + 1));
  return words.slice(start, start + len).join(" ");
}

// Generate a schema-valid value for arbitrary shapes (used for properties
// beyond the label/confidence/rationale trio).
function genValue(schema, unitText, rand) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.enum) return schema.enum[Math.floor(rand() * schema.enum.length)];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string": return snippetOf(unitText, rand);
    case "number": {
      const lo = schema.minimum ?? 0;
      const hi = schema.maximum ?? 1;
      return Math.round((lo + rand() * (hi - lo)) * 100) / 100;
    }
    case "integer": {
      const lo = schema.minimum ?? 0;
      const hi = schema.maximum ?? 10;
      return lo + Math.floor(rand() * (hi - lo + 1));
    }
    case "boolean": return rand() < 0.5;
    case "array": {
      const n = 1 + Math.floor(rand() * 2);
      return Array.from({ length: n }, () => genValue(schema.items ?? { type: "string" }, unitText, rand));
    }
    case "object": {
      const out = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) out[k] = genValue(sub, unitText, rand);
      return out;
    }
    default: return snippetOf(unitText, rand);
  }
}

export class MockAdapter extends Adapter {
  constructor(cfg = {}) {
    super({ name: "mock" });
    this.accuracy = cfg.accuracy ?? 0.9;
    this.oracle = null; // fn(unitText, schemaOrInstrument) → correct label
    this.handlers = new Map();
  }

  setOracle(fn) { this.oracle = fn; return this; }
  setAccuracy(a) { this.accuracy = a; return this; }
  setHandler(name, fn) { this.handlers.set(name, fn); return this; }

  capabilities() {
    return { structuredOutput: true, pinning: true, batch: false, local: true, family: "mock" };
  }

  async catalog() {
    return [{
      id: "mock-1", name: "Mock Model (deterministic)", family: "mock", ctx: 128_000,
      pricing: { inUSDper1M: 0, outUSDper1M: 0 }, snapshot: "mock-1",
    }];
  }

  async complete(req) {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    // req.seed participates so seed-variation runs see real variance; absent
    // seed concatenates "" and keeps the historical byte-identical stream.
    const seed = parseInt(sha256(req.model + lastUser + (req.seed ?? "")).slice(0, 8), 16);
    const rand = mulberry32(seed);
    await sleep(5 + Math.floor(rand() * 16)); // 5–20ms, seeded

    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const handlerName = system.match(/\[\[handler:([\w.-]+)\]\]/)?.[1];

    let json;
    let text;
    if (handlerName && this.handlers.has(handlerName)) {
      json = await this.handlers.get(handlerName)(req);
      text = JSON.stringify(json);
    } else if (req.schema) {
      json = this.#emit(req.schema, extractUnit(lastUser), rand);
      text = JSON.stringify(json);
    } else {
      text = this.#prose(extractUnit(lastUser), rand);
    }

    const inChars = req.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const outTarget = req.maxTokens ?? 256;
    const usage = {
      inputTokens: Math.max(1, Math.round((inChars / 3.6) * (0.95 + rand() * 0.1))),
      // Clamped to the maxTokens-derived target so metered actuals can never
      // exceed what the cost estimator assumed.
      outputTokens: Math.max(1, Math.min(outTarget, Math.round(outTarget * (0.85 + rand() * 0.3)))),
    };
    return { text, json, usage, finishReason: "stop", raw: { mock: true, seed }, servedBy: "mock" };
  }

  // Judge emulation: agree with the oracle at `accuracy`, confidence skewed up
  // when agreeing, rationale templated from unit-text snippets.
  #emit(schema, unitText, rand) {
    const props = schema.properties ?? {};
    const out = {};
    let agreed = null;

    if ("label" in props) {
      const allowed = props.label.enum ?? null;
      // Continuous constructs (score0to100, Likert) type the label numeric with
      // NO enum. Without this, the oracle-less fallback emitted a STRING snippet
      // and the disagreement branch a `not-…` string — both off-schema, so a
      // keyless run of a continuous construct quarantined 100% of its units.
      // genValue is the mock's own in-range numeric generator.
      const labelType = Array.isArray(props.label.type) ? props.label.type[0] : props.label.type;
      const numericLabel = !allowed && (labelType === "number" || labelType === "integer");
      let correct = this.oracle ? this.oracle(unitText, schema) : undefined;
      if (correct === undefined || correct === null) {
        if (allowed) correct = allowed[Math.floor(rand() * allowed.length)];
        else if (numericLabel) correct = genValue(props.label, unitText, rand);
        else correct = snippetOf(unitText, rand).split(/\s+/)[0];
      }
      agreed = rand() < this.accuracy;
      if (agreed) {
        out.label = correct;
      } else if (allowed) {
        // Disagreement must still be schema-valid: pick a different enum
        // value. A single-value enum has no alternative, so agreement is
        // forced rather than emitting an off-enum label.
        const others = allowed.filter((v) => v !== correct);
        out.label = others.length > 0 ? others[Math.floor(rand() * others.length)] : correct;
      } else if (numericLabel) {
        // A different in-range number expresses disagreement while staying valid.
        out.label = genValue(props.label, unitText, rand);
      } else {
        out.label = `not-${correct}`;
      }
    }
    if ("confidence" in props) {
      const c = agreed !== false ? 0.74 + rand() * 0.25 : 0.55 + rand() * 0.2;
      out.confidence = Math.round(c * 100) / 100;
    }
    if ("rationale" in props) {
      const snippet = snippetOf(unitText, rand);
      const template = RATIONALE_TEMPLATES[Math.floor(rand() * RATIONALE_TEMPLATES.length)];
      out.rationale = template(snippet, String(out.label ?? "the assigned reading"));
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in out) continue;
      out[key] = genValue(sub, unitText, rand);
    }
    return out;
  }

  #prose(unitText, rand) {
    const opener = PROSE_OPENERS[Math.floor(rand() * PROSE_OPENERS.length)];
    const snippet = snippetOf(unitText, rand);
    return `${opener} phrases like "${snippet}" recur and anchor the dominant pattern. (Deterministic mock output.)`;
  }
}
