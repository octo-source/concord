// Anthropic Messages API adapter. Structured output via forced tool use:
// the schema becomes the lone "emit" tool and tool_choice pins it.
import { ConcordError } from "../core/errors.js";
import { Adapter, httpJSON } from "./base.js";

const API_VERSION = "2023-06-01";

// Pricing is a static estimate (per 1M tokens) used for preflight cost math
// when no live source exists; every entry is marked `estimate: true`.
const STATIC_CATALOG = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", family: "anthropic", ctx: 200_000, pricing: { inUSDper1M: 15, outUSDper1M: 75 }, snapshot: "claude-opus-4-8", estimate: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "anthropic", ctx: 200_000, pricing: { inUSDper1M: 3, outUSDper1M: 15 }, snapshot: "claude-sonnet-4-6", estimate: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", family: "anthropic", ctx: 200_000, pricing: { inUSDper1M: 1, outUSDper1M: 5 }, snapshot: "claude-haiku-4-5", estimate: true },
];

export class AnthropicAdapter extends Adapter {
  constructor(cfg = {}) {
    super({ name: "anthropic", apiKey: cfg.apiKey, baseUrl: cfg.baseUrl ?? "https://api.anthropic.com" });
  }

  capabilities() {
    return { structuredOutput: true, pinning: true, batch: false, local: false, family: "anthropic" };
  }

  async complete(req) {
    if (!this.apiKey) {
      throw new ConcordError("CONFIG_MISSING", "anthropic: no API key configured (Settings → Providers)", { provider: "anthropic" });
    }
    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0,
      messages: req.messages.filter((m) => m.role !== "system"),
    };
    if (system) body.system = system;
    if (req.schema) {
      body.tools = [{ name: "emit", description: "Emit the structured judgment.", input_schema: req.schema }];
      body.tool_choice = { type: "tool", name: "emit" };
    }
    const raw = await httpJSON("POST", `${this.baseUrl}/v1/messages`, {
      headers: { "x-api-key": this.apiKey, "anthropic-version": API_VERSION },
      body,
    });
    const blocks = raw.content ?? [];
    const tool = blocks.find((b) => b.type === "tool_use");
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    return {
      text: text || undefined,
      json: tool ? tool.input : undefined,
      usage: { inputTokens: raw.usage?.input_tokens ?? 0, outputTokens: raw.usage?.output_tokens ?? 0 },
      finishReason: raw.stop_reason ?? "stop",
      raw,
    };
  }

  async catalog() {
    return STATIC_CATALOG.map((m) => ({ ...m, pricing: { ...m.pricing } }));
  }
}
