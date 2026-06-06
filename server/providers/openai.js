// OpenAI Chat Completions adapter. Structured output via response_format
// json_schema (strict). OpenRouter subclasses this and tweaks the dialect.
import { ConcordError } from "../core/errors.js";
import { Adapter, httpJSON, malformedResponse } from "./base.js";

const STATIC_CATALOG = [
  { id: "gpt-5.2", name: "GPT-5.2", family: "openai", ctx: 400_000, pricing: { inUSDper1M: 1.25, outUSDper1M: 10 }, snapshot: "gpt-5.2", estimate: true },
  { id: "gpt-5.2-mini", name: "GPT-5.2 mini", family: "openai", ctx: 400_000, pricing: { inUSDper1M: 0.25, outUSDper1M: 2 }, snapshot: "gpt-5.2-mini", estimate: true },
];

// ---------------------------------------------------------------------------
// OpenAI strict dialect (live-verified 2026-06 against openai/gpt-4o-mini):
//   - `required` must list EVERY key in `properties` at EVERY object level;
//     one missing key → HTTP 400 ("Missing 'confidence'"). Optionality is
//     expressed as nullability instead: type [t, "null"].
//   - minimum/maximum ARE accepted under strict → kept.
//   - an enum stays valid when its type is unioned with "null" (enum kept);
//     enum-only properties (no declared type) are accepted as-is.
// toOpenAIStrict deep-copies as it walks: req.schema is NEVER mutated, so
// validateSchema/completeWithRepair keep checking responses against the
// ORIGINAL (optional-friendly) schema. The flip side lives in parseResponse:
// explicit nulls the transform invited are deleted so downstream sees the
// field ABSENT, exactly as Anthropic tool-use would deliver it.

const typeList = (t) => (t === undefined ? [] : [].concat(t));

// Base types of an enum-only node, derived from its values.
function enumTypes(values) {
  const out = [];
  for (const v of values) {
    const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// Property was optional in the original schema → make it nullable on the wire.
function makeNullable(node) {
  if (!node || typeof node !== "object") return node;
  const out = { ...node };
  if (Array.isArray(out.anyOf)) {
    if (!out.anyOf.some((m) => typeList(m?.type).includes("null"))) out.anyOf = [...out.anyOf, { type: "null" }];
    return out;
  }
  let types = typeList(out.type);
  if (types.length === 0 && Array.isArray(out.enum)) types = enumTypes(out.enum);
  if (types.length === 0) return out; // no type basis ({} free-form) — leave untouched
  if (!types.includes("null")) types = [...types, "null"];
  out.type = types;
  return out;
}

export function toOpenAIStrict(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = { ...schema };
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(toOpenAIStrict);
  if (out.items !== undefined) {
    out.items = Array.isArray(out.items) ? out.items.map(toOpenAIStrict) : toOpenAIStrict(out.items);
  }
  const isObject = typeList(out.type).includes("object") || (out.type === undefined && out.properties !== undefined);
  if (isObject) {
    if (out.type === undefined) out.type = "object"; // Director-generated schemas may omit it; strict demands it
    out.additionalProperties = false;
    const required = new Set(Array.isArray(out.required) ? out.required : []);
    const props = {};
    for (const [key, sub] of Object.entries(out.properties ?? {})) {
      const t = toOpenAIStrict(sub);
      props[key] = required.has(key) ? t : makeNullable(t);
    }
    out.properties = props;
    out.required = Object.keys(props); // every key, every level
  }
  return out;
}

const allowsNull = (s) =>
  typeList(s?.type).includes("null") || (Array.isArray(s?.enum) && s.enum.includes(null));

// Delete explicit nulls the strict transform invited: a null is removed only
// where the ORIGINAL schema neither requires the key nor allows null itself.
// Recurses through properties and array items; anyOf nodes are left alone
// (no reliable branch choice). Mutates `value` in place (a fresh JSON.parse).
function stripTransformNulls(value, schema) {
  if (!schema || typeof schema !== "object" || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (schema.items && !Array.isArray(schema.items)) {
      for (const v of value) stripTransformNulls(v, schema.items);
    }
    return;
  }
  const props = schema.properties;
  if (!props || typeof props !== "object") return;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, sub] of Object.entries(props)) {
    if (!(key in value)) continue;
    if (value[key] === null && !required.has(key) && !allowsNull(sub)) delete value[key];
    else stripTransformNulls(value[key], sub);
  }
}

export class OpenAIAdapter extends Adapter {
  constructor(cfg = {}) {
    super({ name: cfg.name ?? "openai", apiKey: cfg.apiKey, baseUrl: cfg.baseUrl ?? "https://api.openai.com" });
  }

  capabilities() {
    return { structuredOutput: true, pinning: true, batch: false, local: false, family: "openai" };
  }

  buildBody(req) {
    const body = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0,
      max_completion_tokens: req.maxTokens ?? 1024,
    };
    if (req.seed !== undefined) body.seed = req.seed;
    if (req.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "emit", schema: toOpenAIStrict(req.schema), strict: true },
      };
    }
    return body;
  }

  headers() {
    const h = {};
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async complete(req) {
    if (!this.apiKey) {
      throw new ConcordError("CONFIG_MISSING", `${this.name}: no API key configured (Settings → Providers)`, { provider: this.name });
    }
    const raw = await httpJSON("POST", `${this.baseUrl}/v1/chat/completions`, {
      headers: this.headers(),
      body: this.buildBody(req),
    });
    return this.parseResponse(raw, req);
  }

  parseResponse(raw, req) {
    // A 200 with an empty/HTML/shapeless body must not TypeError downstream.
    if (!raw || !Array.isArray(raw.choices) || raw.choices.length === 0) {
      throw malformedResponse(this.name, raw);
    }
    const choice = raw.choices[0] ?? {};
    const message = choice.message ?? {};
    // Fast-fail outcomes that no amount of schema repair can fix; these are
    // not SCHEMA_INVALID, so completeWithRepair lets them propagate untouched.
    if (message.refusal) {
      throw new ConcordError(
        "PROVIDER_REFUSAL",
        `${this.name}: model refused the request: ${String(message.refusal).slice(0, 300)}`,
        { provider: this.name, refusal: message.refusal, finishReason: choice.finish_reason ?? null },
      );
    }
    if (choice.finish_reason === "length" && req.schema) {
      throw new ConcordError(
        "TRUNCATED",
        `${this.name}: structured output truncated at the token limit; raise maxTokens (currently ${req.maxTokens ?? "default"}) and retry`,
        { provider: this.name, maxTokens: req.maxTokens ?? null, advice: "raise maxTokens" },
      );
    }
    const text = typeof message.content === "string" ? message.content : undefined;
    let json;
    if (req.schema && text !== undefined) {
      try { json = JSON.parse(text); } catch { /* completeWithRepair handles it */ }
      // Normalize strict-dialect nulls to ABSENT against the ORIGINAL schema:
      // downstream (`json.confidence ?? null` in judge.js, validateSchema)
      // treats optional fields as present-or-absent, never explicit null.
      if (json !== undefined) stripTransformNulls(json, req.schema);
    }
    return {
      text,
      json,
      usage: { inputTokens: raw.usage?.prompt_tokens ?? 0, outputTokens: raw.usage?.completion_tokens ?? 0 },
      finishReason: choice.finish_reason ?? "stop",
      raw,
    };
  }

  async catalog() {
    return STATIC_CATALOG.map((m) => ({ ...m, pricing: { ...m.pricing } }));
  }
}
