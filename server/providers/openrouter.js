// OpenRouter: OpenAI-compatible gateway to the long tail. Adds attribution
// headers, records which upstream actually served the call (servedBy), and
// exposes the live model catalog with real per-token pricing.
import { OpenAIAdapter } from "./openai.js";
import { httpJSON } from "./base.js";

// "meta-llama/llama-3.3-70b" → "meta"; "openai/gpt-5.2" → "openai".
const familyOf = (modelId) => String(modelId).split("/")[0].split("-")[0];

// OpenRouter pricing is USD per token (string); catalog wants USD per 1M.
const perMillion = (v) => (v == null ? 0 : Math.round(Number(v) * 1e6 * 1e4) / 1e4);

export class OpenRouterAdapter extends OpenAIAdapter {
  constructor(cfg = {}) {
    super({ name: "openrouter", apiKey: cfg.apiKey, baseUrl: cfg.baseUrl ?? "https://openrouter.ai/api" });
  }

  capabilities() {
    // pinning false: long-tail upstreams swap snapshots beneath the model id.
    return { structuredOutput: true, pinning: false, batch: false, local: false, family: "openrouter" };
  }

  buildBody(req) {
    const body = super.buildBody(req);
    body.max_tokens = body.max_completion_tokens; // OpenRouter dialect
    delete body.max_completion_tokens;
    return body;
  }

  headers() {
    return { ...super.headers(), "HTTP-Referer": "https://concord.local", "X-Title": "Concord" };
  }

  parseResponse(raw, req) {
    const res = super.parseResponse(raw, req);
    if (raw.provider) res.servedBy = raw.provider;
    return res;
  }

  async catalog() {
    const raw = await httpJSON("GET", `${this.baseUrl}/v1/models`, { headers: this.headers() });
    return (raw.data ?? []).map((m) => {
      // Per-model capability flags from supported_parameters (present on every
      // live entry, 2026-06; absent → conservative flags, never a throw).
      // OpenRouter SILENTLY ignores response_format on models that lack it —
      // the repair loop still lands valid JSON, just slowly — so these flags
      // exist for the UI to warn + default-filter, not to hard-block.
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      return {
        id: m.id,
        name: m.name ?? m.id,
        family: familyOf(m.id),
        ctx: m.context_length ?? null,
        pricing: { inUSDper1M: perMillion(m.pricing?.prompt), outUSDper1M: perMillion(m.pricing?.completion) },
        snapshot: m.id,
        structuredOutput: params.includes("structured_outputs") || params.includes("response_format"),
        noTemperature: !params.includes("temperature"),
        params,
      };
    });
  }
}
