// OpenAI Chat Completions adapter. Structured output via response_format
// json_schema (strict). OpenRouter subclasses this and tweaks the dialect.
import { ConcordError } from "../core/errors.js";
import { Adapter, httpJSON } from "./base.js";

const STATIC_CATALOG = [
  { id: "gpt-5.2", name: "GPT-5.2", family: "openai", ctx: 400_000, pricing: { inUSDper1M: 1.25, outUSDper1M: 10 }, snapshot: "gpt-5.2", estimate: true },
  { id: "gpt-5.2-mini", name: "GPT-5.2 mini", family: "openai", ctx: 400_000, pricing: { inUSDper1M: 0.25, outUSDper1M: 2 }, snapshot: "gpt-5.2-mini", estimate: true },
];

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
      body.response_format = { type: "json_schema", json_schema: { name: "emit", schema: req.schema, strict: true } };
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
    const choice = raw.choices?.[0] ?? {};
    const text = typeof choice.message?.content === "string" ? choice.message.content : undefined;
    let json;
    if (req.schema && text !== undefined) {
      try { json = JSON.parse(text); } catch { /* completeWithRepair handles it */ }
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
