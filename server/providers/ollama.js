// Ollama (or any compatible local endpoint). Local: free, keyless, and the
// only network adapter allowed under privacy mode "strict".
import { ConcordError } from "../core/errors.js";
import { Adapter, httpJSON, malformedResponse, validateSchema } from "./base.js";

const DEFAULT_BASE_URL = "http://localhost:11434";

export class OllamaAdapter extends Adapter {
  constructor(cfg = {}) {
    super({ name: "ollama", baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL });
  }

  capabilities() {
    // pinning false: tags like :latest can drift beneath the same name.
    return { structuredOutput: true, pinning: false, batch: false, local: true, family: "ollama" };
  }

  async complete(req) {
    const body = {
      model: req.model,
      messages: req.messages,
      stream: false,
      options: { temperature: req.temperature ?? 0 },
    };
    if (req.seed !== undefined) body.options.seed = req.seed;
    if (req.maxTokens !== undefined) body.options.num_predict = req.maxTokens;
    if (req.schema) body.format = "json";
    const raw = await httpJSON("POST", `${this.baseUrl}/api/chat`, { body });
    // A 200 with an empty/HTML/shapeless body must not TypeError downstream.
    if (!raw || typeof raw !== "object" || !raw.message || typeof raw.message !== "object") {
      throw malformedResponse("ollama", raw);
    }
    const text = typeof raw.message.content === "string" ? raw.message.content : undefined;
    let json;
    if (req.schema && text !== undefined) {
      try {
        json = JSON.parse(text);
      } catch {
        /* completeWithRepair handles it */
      }
    }
    // Truncation fast-fail (mirrors openai.js finish_reason==="length" and the
    // anthropic max_tokens guard): num_predict exhausted mid-generation reports
    // done_reason "length". If the schema'd output didn't come back valid, the
    // repair loop would re-prompt at the SAME num_predict and quarantine as
    // SCHEMA_INVALID; TRUNCATED instead lets withTruncationRetry double the
    // budget. A complete, schema-valid emission passes through even at "length"
    // (the budget was simply generous).
    if (
      req.schema &&
      raw.done_reason === "length" &&
      (json === undefined || validateSchema(json, req.schema).length > 0)
    ) {
      throw new ConcordError(
        "TRUNCATED",
        `ollama: structured output truncated at the token limit; raise maxTokens (currently ${req.maxTokens ?? "default"}) and retry`,
        { provider: "ollama", maxTokens: req.maxTokens ?? null, advice: "raise maxTokens" },
      );
    }
    return {
      text,
      json,
      usage: { inputTokens: raw.prompt_eval_count ?? 0, outputTokens: raw.eval_count ?? 0 },
      finishReason: raw.done_reason ?? "stop",
      raw,
    };
  }

  async catalog() {
    const raw = await httpJSON("GET", `${this.baseUrl}/api/tags`);
    return (raw.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
      family: m.details?.family || "ollama",
      ctx: null, // /api/tags does not report context length
      pricing: { inUSDper1M: 0, outUSDper1M: 0 },
      snapshot: m.digest || m.name,
    }));
  }

  // Auto-discovery: is a local Ollama listening? 300ms budget, never throws.
  static async discover(baseUrl = DEFAULT_BASE_URL) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal });
      return res.ok ? baseUrl : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
