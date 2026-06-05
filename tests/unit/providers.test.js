// Task D — provider layer tests. Fully hermetic: every "provider API" here is
// a local node:http server on an ephemeral 127.0.0.1 port; no test touches a
// real network. MockModel tests are deterministic by construction.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Adapter, Pool, completeWithRepair, parseRetryAfter, validateSchema,
} from "../../server/providers/base.js";
import { AnthropicAdapter } from "../../server/providers/anthropic.js";
import { OpenAIAdapter } from "../../server/providers/openai.js";
import { OpenRouterAdapter } from "../../server/providers/openrouter.js";
import { OllamaAdapter } from "../../server/providers/ollama.js";
import { MockAdapter } from "../../server/providers/mock.js";
import { getAdapter } from "../../server/providers/registry.js";
import { estimateRun, meter, checkBudget } from "../../server/providers/costs.js";
import { mulberry32 } from "../../server/core/rng.js";

// ---------------------------------------------------------------- helpers

// Local HTTP server. handler(call, n) → {status?, headers?, body} | null (hang).
function startServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      const call = { method: req.method, url: req.url, headers: req.headers, body, at: Date.now() };
      calls.push(call);
      const out = handler(call, calls.length);
      if (out === null) return; // hang forever (for timeout tests)
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
      });
    });
  });
}

async function withServer(handler, fn) {
  const srv = await startServer(handler);
  try { return await fn(srv); } finally { await srv.close(); }
}

const judgeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rationale", "label", "confidence"],
  properties: {
    rationale: { type: "string" },
    label: { type: "string", enum: ["pay", "management", "workload"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

const anthropicToolResponse = (json) => ({
  body: {
    id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    stop_reason: "tool_use", stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 45 },
    content: [{ type: "tool_use", id: "toolu_01", name: "emit", input: json }],
  },
});

const openaiResponse = (content, extra = {}) => ({
  body: {
    id: "chatcmpl-1", object: "chat.completion", model: "gpt-5.2",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 20 },
    ...extra,
  },
});

// Scripted in-memory adapter for completeWithRepair tests.
function scriptedAdapter(texts) {
  const calls = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const text = texts[Math.min(calls.length - 1, texts.length - 1)];
      return { text, usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop", raw: {} };
    },
  };
}

// ---------------------------------------------------------------- Pool

describe("Pool", () => {
  it("retries 429s and succeeds on the 3rd attempt with growing delays", async () => {
    await withServer(
      (call, n) => (n < 3 ? { status: 429, body: { error: { type: "rate_limit_error" } } } : anthropicToolResponse({ label: "pay" })),
      async (srv) => {
        const adapter = new AnthropicAdapter({ apiKey: "k", baseUrl: srv.url });
        const pool = new Pool({ concurrency: 1, baseDelayMs: 60 });
        const res = await pool.run(() => adapter.complete({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "judge" }],
          schema: judgeSchema, temperature: 0, maxTokens: 64,
        }));
        assert.equal(res.json.label, "pay");
        assert.equal(srv.calls.length, 3);
        const d1 = srv.calls[1].at - srv.calls[0].at;
        const d2 = srv.calls[2].at - srv.calls[1].at;
        assert.ok(d1 >= 40, `first backoff too small: ${d1}ms`);
        assert.ok(d2 >= 95, `second backoff too small: ${d2}ms`);
        assert.ok(d2 > d1, `delays not increasing: ${d1}ms then ${d2}ms`);
      },
    );
  });

  it("throws RATE_LIMITED_EXHAUSTED after exactly 6 attempts", async () => {
    await withServer(
      () => ({ status: 429, body: {} }),
      async (srv) => {
        const adapter = new AnthropicAdapter({ apiKey: "k", baseUrl: srv.url });
        const pool = new Pool({ concurrency: 1, baseDelayMs: 4 });
        await assert.rejects(
          pool.run(() => adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0, maxTokens: 16 })),
          (err) => err.code === "RATE_LIMITED_EXHAUSTED" && err.details.attempts === 6,
        );
        assert.equal(srv.calls.length, 6);
      },
    );
  });

  it("honors Retry-After header", async () => {
    await withServer(
      (call, n) => (n === 1
        ? { status: 429, headers: { "retry-after": "1" }, body: {} }
        : anthropicToolResponse({ label: "pay" })),
      async (srv) => {
        const adapter = new AnthropicAdapter({ apiKey: "k", baseUrl: srv.url });
        const pool = new Pool({ concurrency: 1, baseDelayMs: 5 });
        await pool.run(() => adapter.complete({
          model: "m", messages: [{ role: "user", content: "x" }], schema: judgeSchema, temperature: 0, maxTokens: 16,
        }));
        assert.equal(srv.calls.length, 2);
        assert.ok(srv.calls[1].at - srv.calls[0].at >= 950, "Retry-After: 1 not honored");
      },
    );
  });

  it("does not retry non-retryable HTTP errors", async () => {
    await withServer(
      () => ({ status: 400, body: { error: { type: "invalid_request_error" } } }),
      async (srv) => {
        const adapter = new AnthropicAdapter({ apiKey: "k", baseUrl: srv.url });
        const pool = new Pool({ concurrency: 1, baseDelayMs: 5 });
        await assert.rejects(
          pool.run(() => adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0, maxTokens: 16 })),
          (err) => err.code === "PROVIDER_HTTP" && err.details.status === 400,
        );
        assert.equal(srv.calls.length, 1);
      },
    );
  });

  it("caps concurrent executions", async () => {
    const pool = new Pool({ concurrency: 2 });
    let active = 0, peak = 0;
    await Promise.all(Array.from({ length: 6 }, () => pool.run(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
    })));
    assert.equal(peak, 2);
  });

  it("paces starts to the rpm window", async () => {
    const pool = new Pool({ concurrency: 5, rpm: 2, windowMs: 150 });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => pool.run(async () => {})));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 120, `4 calls at rpm=2/window=150ms finished in ${elapsed}ms`);
  });

  it("parseRetryAfter handles seconds, dates, junk", () => {
    assert.equal(parseRetryAfter("1"), 1000);
    assert.equal(parseRetryAfter("0"), 0);
    const ms = parseRetryAfter(new Date(Date.now() + 5000).toUTCString());
    assert.ok(ms > 2500 && ms <= 6000, `date Retry-After parsed to ${ms}`);
    assert.equal(parseRetryAfter("soon"), null);
    assert.equal(parseRetryAfter(null), null);
  });
});

// ---------------------------------------------------------------- Anthropic

describe("AnthropicAdapter", () => {
  it("forces tool use for schemas and parses the tool_use block", async () => {
    const json = { rationale: "mentions pay", label: "pay", confidence: 0.91 };
    await withServer(
      () => anthropicToolResponse(json),
      async (srv) => {
        const adapter = new AnthropicAdapter({ apiKey: "sk-ant-test", baseUrl: srv.url });
        const res = await adapter.complete({
          model: "claude-sonnet-4-6",
          messages: [
            { role: "system", content: "You are a careful judge." },
            { role: "user", content: "Label this. <unit>The pay is terrible.</unit>" },
          ],
          schema: judgeSchema, temperature: 0, maxTokens: 200,
        });
        const call = srv.calls[0];
        assert.equal(call.method, "POST");
        assert.equal(call.url, "/v1/messages");
        assert.equal(call.headers["x-api-key"], "sk-ant-test");
        assert.equal(call.headers["anthropic-version"], "2023-06-01");
        assert.equal(call.body.model, "claude-sonnet-4-6");
        assert.equal(call.body.system, "You are a careful judge.");
        assert.deepEqual(call.body.messages, [{ role: "user", content: "Label this. <unit>The pay is terrible.</unit>" }]);
        assert.equal(call.body.temperature, 0);
        assert.equal(call.body.max_tokens, 200);
        assert.equal(call.body.tools.length, 1);
        assert.equal(call.body.tools[0].name, "emit");
        assert.deepEqual(call.body.tools[0].input_schema, judgeSchema);
        assert.deepEqual(call.body.tool_choice, { type: "tool", name: "emit" });

        assert.deepEqual(res.json, json);
        assert.deepEqual(res.usage, { inputTokens: 120, outputTokens: 45 });
        assert.equal(res.finishReason, "tool_use");
        assert.ok(res.raw && res.raw.id === "msg_01");
      },
    );
  });

  it("plain completion sends no tools and returns text", async () => {
    await withServer(
      () => ({
        body: {
          id: "msg_02", content: [{ type: "text", text: "hello there" }],
          stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 3 },
        },
      }),
      async (srv) => {
        const adapter = new AnthropicAdapter({ apiKey: "k", baseUrl: srv.url });
        const res = await adapter.complete({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0, maxTokens: 50 });
        assert.equal(srv.calls[0].body.tools, undefined);
        assert.equal(srv.calls[0].body.tool_choice, undefined);
        assert.equal(res.text, "hello there");
        assert.equal(res.json, undefined);
        assert.equal(res.finishReason, "end_turn");
      },
    );
  });

  it("keyless: complete throws CONFIG_MISSING without any fetch; catalog still works", async () => {
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = () => { fetches++; throw new Error("network blocked by test"); };
    try {
      const adapter = new AnthropicAdapter({});
      await assert.rejects(
        adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0, maxTokens: 16 }),
        { code: "CONFIG_MISSING" },
      );
      assert.equal(fetches, 0);
      const cat = await adapter.catalog();
      assert.equal(fetches, 0);
      const ids = cat.map((m) => m.id);
      assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
      for (const m of cat) {
        assert.equal(m.estimate, true);
        assert.equal(m.family, "anthropic");
        assert.ok(m.pricing.inUSDper1M > 0 && m.pricing.outUSDper1M > 0);
        assert.ok(m.ctx > 0 && typeof m.snapshot === "string");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("capabilities", () => {
    assert.deepEqual(new AnthropicAdapter({}).capabilities(),
      { structuredOutput: true, pinning: true, batch: false, local: false, family: "anthropic" });
  });
});

// ---------------------------------------------------------------- OpenAI

describe("OpenAIAdapter", () => {
  it("round-trips json_schema response_format", async () => {
    await withServer(
      () => openaiResponse('{"rationale":"says pay","label":"pay","confidence":0.8}'),
      async (srv) => {
        const adapter = new OpenAIAdapter({ apiKey: "sk-oai-test", baseUrl: srv.url });
        const messages = [
          { role: "system", content: "Judge." },
          { role: "user", content: "Label: <unit>pay is bad</unit>" },
        ];
        const res = await adapter.complete({ model: "gpt-5.2", messages, schema: judgeSchema, temperature: 0, maxTokens: 150, seed: 11 });
        const call = srv.calls[0];
        assert.equal(call.url, "/v1/chat/completions");
        assert.equal(call.headers.authorization, "Bearer sk-oai-test");
        assert.deepEqual(call.body.messages, messages);
        assert.equal(call.body.temperature, 0);
        assert.equal(call.body.max_completion_tokens, 150);
        assert.equal(call.body.seed, 11);
        assert.deepEqual(call.body.response_format, {
          type: "json_schema",
          json_schema: { name: "emit", schema: judgeSchema, strict: true },
        });
        assert.deepEqual(res.json, { rationale: "says pay", label: "pay", confidence: 0.8 });
        assert.deepEqual(res.usage, { inputTokens: 80, outputTokens: 20 });
        assert.equal(res.finishReason, "stop");
      },
    );
  });

  it("keyless throws CONFIG_MISSING; static catalog marked estimate", async () => {
    const adapter = new OpenAIAdapter({});
    await assert.rejects(
      adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0, maxTokens: 16 }),
      { code: "CONFIG_MISSING" },
    );
    const cat = await adapter.catalog();
    assert.ok(cat.length >= 2);
    for (const m of cat) {
      assert.equal(m.estimate, true);
      assert.equal(m.family, "openai");
      assert.ok(m.pricing.inUSDper1M > 0);
    }
    assert.deepEqual(adapter.capabilities(),
      { structuredOutput: true, pinning: true, batch: false, local: false, family: "openai" });
  });
});

// ---------------------------------------------------------------- OpenRouter

describe("OpenRouterAdapter", () => {
  it("sends attribution headers and records servedBy", async () => {
    await withServer(
      () => openaiResponse('{"rationale":"r","label":"pay","confidence":0.7}', { provider: "Fireworks" }),
      async (srv) => {
        const adapter = new OpenRouterAdapter({ apiKey: "sk-or-test", baseUrl: srv.url });
        const res = await adapter.complete({
          model: "meta-llama/llama-3.3-70b-instruct",
          messages: [{ role: "user", content: "x" }],
          schema: judgeSchema, temperature: 0, maxTokens: 100,
        });
        const call = srv.calls[0];
        assert.equal(call.url, "/v1/chat/completions");
        assert.equal(call.headers["http-referer"], "https://concord.local");
        assert.equal(call.headers["x-title"], "Concord");
        assert.equal(call.headers.authorization, "Bearer sk-or-test");
        assert.equal(call.body.max_tokens, 100); // OpenRouter dialect keeps max_tokens
        assert.equal(res.servedBy, "Fireworks");
        assert.equal(res.json.label, "pay");
      },
    );
  });

  it("maps the live model catalog, deriving family from the model prefix", async () => {
    await withServer(
      (call) => {
        assert.equal(call.url, "/v1/models");
        return {
          body: {
            data: [
              { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", context_length: 131072, pricing: { prompt: "0.00000012", completion: "0.0000003" } },
              { id: "openai/gpt-5.2", name: "GPT-5.2", context_length: 400000, pricing: { prompt: "0.00000125", completion: "0.00001" } },
            ],
          },
        };
      },
      async (srv) => {
        const adapter = new OpenRouterAdapter({ apiKey: "k", baseUrl: srv.url });
        const cat = await adapter.catalog();
        assert.deepEqual(cat[0], {
          id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", family: "meta",
          ctx: 131072, pricing: { inUSDper1M: 0.12, outUSDper1M: 0.3 },
          snapshot: "meta-llama/llama-3.3-70b-instruct",
        });
        assert.equal(cat[1].family, "openai");
        assert.equal(cat[1].pricing.inUSDper1M, 1.25);
      },
    );
  });
});

// ---------------------------------------------------------------- Ollama

describe("OllamaAdapter", () => {
  it("posts /api/chat with format json and options when schema present", async () => {
    await withServer(
      () => ({
        body: {
          model: "llama3.2:3b", message: { role: "assistant", content: '{"rationale":"r","label":"pay","confidence":0.6}' },
          done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 10,
        },
      }),
      async (srv) => {
        const adapter = new OllamaAdapter({ baseUrl: srv.url });
        const res = await adapter.complete({
          model: "llama3.2:3b", messages: [{ role: "user", content: "x" }],
          schema: judgeSchema, temperature: 0, maxTokens: 128, seed: 7,
        });
        const call = srv.calls[0];
        assert.equal(call.url, "/api/chat");
        assert.equal(call.body.format, "json");
        assert.equal(call.body.stream, false);
        assert.equal(call.body.options.temperature, 0);
        assert.equal(call.body.options.seed, 7);
        assert.equal(call.body.options.num_predict, 128);
        assert.deepEqual(res.json, { rationale: "r", label: "pay", confidence: 0.6 });
        assert.deepEqual(res.usage, { inputTokens: 50, outputTokens: 10 });
        assert.equal(res.finishReason, "stop");
        const caps = adapter.capabilities();
        assert.equal(caps.local, true);
        assert.equal(caps.family, "ollama");
      },
    );
  });

  it("omits format without a schema", async () => {
    await withServer(
      () => ({ body: { message: { role: "assistant", content: "plain" }, done_reason: "stop" } }),
      async (srv) => {
        const adapter = new OllamaAdapter({ baseUrl: srv.url });
        const res = await adapter.complete({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0.2, maxTokens: 32 });
        assert.equal(srv.calls[0].body.format, undefined);
        assert.equal(res.text, "plain");
      },
    );
  });

  it("builds catalog from /api/tags with zero pricing", async () => {
    await withServer(
      () => ({ body: { models: [{ name: "llama3.2:3b", digest: "abc123", details: { family: "llama" } }] } }),
      async (srv) => {
        const adapter = new OllamaAdapter({ baseUrl: srv.url });
        const cat = await adapter.catalog();
        assert.equal(srv.calls[0].url, "/api/tags");
        assert.deepEqual(cat, [{
          id: "llama3.2:3b", name: "llama3.2:3b", family: "llama", ctx: null,
          pricing: { inUSDper1M: 0, outUSDper1M: 0 }, snapshot: "abc123",
        }]);
      },
    );
  });

  it("discover: returns baseUrl when reachable, null when refused, null on timeout", async () => {
    const live = await startServer(() => ({ body: { models: [] } }));
    assert.equal(await OllamaAdapter.discover(live.url), live.url);
    const deadUrl = live.url;
    await live.close();
    assert.equal(await OllamaAdapter.discover(deadUrl), null);

    const hung = await startServer(() => null); // never responds
    const t0 = Date.now();
    assert.equal(await OllamaAdapter.discover(hung.url), null);
    assert.ok(Date.now() - t0 < 2000, "discover timeout did not trip");
    await hung.close();
  });
});

// ---------------------------------------------------------------- schema repair

describe("completeWithRepair", () => {
  it("re-prompts once on invalid JSON, then succeeds", async () => {
    const adapter = scriptedAdapter([
      "this is not json at all",
      '{"rationale":"fixed","label":"pay","confidence":0.9}',
    ]);
    const req = { model: "m", messages: [{ role: "user", content: "judge it" }], schema: judgeSchema, temperature: 0, maxTokens: 64 };
    const res = await completeWithRepair(adapter, req, { maxRepairs: 1 });
    assert.equal(res.json.label, "pay");
    assert.equal(res.repairs, 1);
    assert.equal(adapter.calls.length, 2);
    const second = adapter.calls[1].messages;
    assert.equal(second.length, 3);
    assert.deepEqual(second[1], { role: "assistant", content: "this is not json at all" });
    assert.equal(second[2].role, "user");
    assert.ok(second[2].content.includes("previous response was not valid JSON for the required schema"));
    assert.ok(second[2].content.includes('"label"'), "repair prompt restates the schema");
    // original request object untouched
    assert.equal(req.messages.length, 1);
  });

  it("throws SCHEMA_INVALID when repairs are exhausted", async () => {
    const adapter = scriptedAdapter(["nope", "still nope"]);
    await assert.rejects(
      completeWithRepair(adapter, { model: "m", messages: [{ role: "user", content: "x" }], schema: judgeSchema, temperature: 0, maxTokens: 64 }, { maxRepairs: 1 }),
      (err) => err.code === "SCHEMA_INVALID" && err.details.problems.length > 0,
    );
    assert.equal(adapter.calls.length, 2);

    const adapter3 = scriptedAdapter(["nope"]);
    await assert.rejects(
      completeWithRepair(adapter3, { model: "m", messages: [{ role: "user", content: "x" }], schema: judgeSchema, temperature: 0, maxTokens: 64 }),
      { code: "SCHEMA_INVALID" },
    );
    assert.equal(adapter3.calls.length, 3); // default maxRepairs = 2
  });

  it("validates content, not just parseability; strips code fences", async () => {
    const adapter = scriptedAdapter([
      '{"rationale":"r","label":"NOT_A_LABEL","confidence":0.5}',
      '```json\n{"rationale":"r","label":"workload","confidence":0.5}\n```',
    ]);
    const res = await completeWithRepair(adapter, { model: "m", messages: [{ role: "user", content: "x" }], schema: judgeSchema, temperature: 0, maxTokens: 64 });
    assert.equal(res.json.label, "workload");
    assert.equal(res.repairs, 1);
  });

  it("passes through when the adapter already returned valid json (repairs: 0)", async () => {
    const mock = new MockAdapter();
    const res = await completeWithRepair(mock, {
      model: "mock-1",
      messages: [{ role: "user", content: "Label.\n<unit>The pay is awful here.</unit>" }],
      schema: judgeSchema, temperature: 0, maxTokens: 64,
    });
    assert.equal(res.repairs, 0);
    assert.deepEqual(validateSchema(res.json, judgeSchema), []);
  });

  it("validateSchema catches type, enum, required, range, extra keys", () => {
    assert.deepEqual(validateSchema({ rationale: "r", label: "pay", confidence: 0.5 }, judgeSchema), []);
    assert.ok(validateSchema({ rationale: "r", label: "zzz", confidence: 0.5 }, judgeSchema).length > 0);
    assert.ok(validateSchema({ rationale: "r", label: "pay" }, judgeSchema).length > 0);
    assert.ok(validateSchema({ rationale: "r", label: "pay", confidence: "high" }, judgeSchema).length > 0);
    assert.ok(validateSchema({ rationale: "r", label: "pay", confidence: 1.5 }, judgeSchema).length > 0);
    assert.ok(validateSchema({ rationale: "r", label: "pay", confidence: 0.5, extra: 1 }, judgeSchema).length > 0);
    assert.ok(validateSchema("not an object", judgeSchema).length > 0);
  });
});

// ---------------------------------------------------------------- registry / privacy

describe("registry privacy gates", () => {
  const noKeys = join(tmpdir(), "concord-definitely-missing", "keys.json");

  it("strict blocks network adapters with zero fetches; locals pass", () => {
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = () => { fetches++; throw new Error("network blocked by test"); };
    try {
      const strict = { privacyMode: "strict" };
      for (const name of ["anthropic", "openai", "openrouter"]) {
        assert.throws(() => getAdapter(strict, name, { keysPath: noKeys }), { code: "PRIVACY_BLOCKED" });
      }
      assert.equal(fetches, 0);
      const m = getAdapter(strict, "mock", { keysPath: noKeys });
      assert.ok(m.adapter instanceof MockAdapter);
      assert.equal(m.ledgerEvent, null);
      const o = getAdapter(strict, "ollama", { keysPath: noKeys });
      assert.ok(o.adapter instanceof OllamaAdapter);
      assert.equal(o.ledgerEvent, null);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("no-training: allowlist passes, openrouter needs a justification", () => {
    const proj = { privacyMode: "no-training" };
    const a = getAdapter(proj, "anthropic", { keysPath: noKeys });
    assert.ok(a.adapter instanceof AnthropicAdapter);
    assert.equal(a.ledgerEvent, null);
    assert.equal(getAdapter(proj, "openai", { keysPath: noKeys }).ledgerEvent, null);

    assert.throws(() => getAdapter(proj, "openrouter", { keysPath: noKeys }), { code: "PRIVACY_BLOCKED" });
    assert.throws(() => getAdapter(proj, "openrouter", { keysPath: noKeys, justification: "   " }), { code: "PRIVACY_BLOCKED" });

    const ok = getAdapter(proj, "openrouter", { keysPath: noKeys, justification: "EU data-residency requirement" });
    assert.ok(ok.adapter instanceof OpenRouterAdapter);
    assert.deepEqual(ok.ledgerEvent, {
      actor: "human",
      type: "privacy.override",
      refs: { provider: "openrouter" },
      payload: { justification: "EU data-residency requirement" },
    });
  });

  it("open allows anything without ledger events", () => {
    const proj = { privacyMode: "open" };
    for (const name of ["anthropic", "openai", "openrouter", "ollama", "mock"]) {
      const { adapter, ledgerEvent } = getAdapter(proj, name, { keysPath: noKeys });
      assert.ok(adapter instanceof Adapter);
      assert.equal(ledgerEvent, null);
    }
  });

  it("unknown provider → CONFIG_MISSING; unknown privacy mode fails closed", () => {
    assert.throws(() => getAdapter({ privacyMode: "open" }, "geminiz", { keysPath: noKeys }), { code: "CONFIG_MISSING" });
    assert.throws(() => getAdapter({ privacyMode: "paranoid" }, "anthropic", { keysPath: noKeys }), { code: "PRIVACY_BLOCKED" });
  });

  it("reads keys.json (object or string entries); absent file → keyless adapter that still catalogs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concord-keys-"));
    try {
      const keysPath = join(dir, "keys.json");
      writeFileSync(keysPath, JSON.stringify({
        anthropic: { apiKey: "sk-ant-aaa", baseUrl: "http://127.0.0.1:1" },
        openai: "sk-oai-flat",
      }));
      const a = getAdapter({ privacyMode: "open" }, "anthropic", { keysPath }).adapter;
      assert.equal(a.apiKey, "sk-ant-aaa");
      assert.equal(a.baseUrl, "http://127.0.0.1:1");
      const o = getAdapter({ privacyMode: "open" }, "openai", { keysPath }).adapter;
      assert.equal(o.apiKey, "sk-oai-flat");

      const keyless = getAdapter({ privacyMode: "open" }, "anthropic", { keysPath: noKeys }).adapter;
      assert.equal(keyless.apiKey, null);
      await assert.rejects(
        keyless.complete({ model: "m", messages: [{ role: "user", content: "x" }], temperature: 0, maxTokens: 8 }),
        { code: "CONFIG_MISSING" },
      );
      assert.equal((await keyless.catalog()).length, 3);

      writeFileSync(keysPath, "{ not json");
      assert.throws(() => getAdapter({ privacyMode: "open" }, "anthropic", { keysPath }), { code: "CONFIG_MISSING" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- MockAdapter

const THEMES = ["pay", "management", "workload", "growth"];
const themeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rationale", "label", "confidence"],
  properties: {
    rationale: { type: "string" },
    label: { type: "string", enum: THEMES },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

function plantedUnits(n) {
  return Array.from({ length: n }, (_, i) => {
    const theme = THEMES[i % THEMES.length];
    return { theme, text: `Unit ${i}: my main issue is ${theme}; it shapes how I feel about this job every single day.` };
  });
}
const judgeReq = (text) => ({
  model: "mock-1",
  messages: [{ role: "user", content: `Apply the codebook.\n<unit>${text}</unit>\nReturn JSON.` }],
  schema: themeSchema, temperature: 0, maxTokens: 120,
});
const oracle = (unitText) => THEMES.find((t) => unitText.includes(`issue is ${t}`)) ?? "pay";

describe("MockAdapter", () => {
  it("is byte-deterministic for identical (model, messages)", async () => {
    const req = judgeReq("The pay is terrible and management ignores us.");
    const r1 = await new MockAdapter().complete(req);
    const r2 = await new MockAdapter().complete(structuredClone(req));
    const r3 = await new MockAdapter().complete(req); // fresh adapter, same request
    assert.equal(JSON.stringify(r1), JSON.stringify(r2));
    assert.equal(JSON.stringify(r1), JSON.stringify(r3));
    const other = await new MockAdapter().complete(judgeReq("Completely different unit about workload."));
    assert.notEqual(JSON.stringify(r1), JSON.stringify(other));
  });

  it("emits schema-valid JSON with confidence in [0.55, 0.99] and a rationale quoting the unit", async () => {
    const mock = new MockAdapter();
    const unit = "The pay is terrible and management ignores us completely.";
    const res = await mock.complete(judgeReq(unit));
    assert.deepEqual(validateSchema(res.json, themeSchema), []);
    assert.ok(res.json.confidence >= 0.55 && res.json.confidence <= 0.99, `confidence ${res.json.confidence}`);
    const quoted = res.json.rationale.match(/"([^"]+)"/);
    assert.ok(quoted, "rationale contains a quoted snippet");
    assert.ok(unit.includes(quoted[1]), `snippet "${quoted[1]}" comes from the unit text`);
    assert.equal(res.text, JSON.stringify(res.json));
    assert.equal(res.servedBy, "mock");
    assert.deepEqual(mock.capabilities(), { structuredOutput: true, pinning: true, batch: false, local: true, family: "mock" });
    const cat = await mock.catalog();
    assert.deepEqual(cat[0].pricing, { inUSDper1M: 0, outUSDper1M: 0 });
    assert.equal(cat[0].family, "mock");
  });

  it("fills arbitrary schema shapes", async () => {
    const wide = {
      type: "object",
      required: ["labels", "salient", "count"],
      properties: {
        labels: { type: "array", items: { type: "string", enum: ["a", "b", "c"] } },
        salient: { type: "boolean" },
        count: { type: "integer", minimum: 0, maximum: 5 },
      },
    };
    const res = await new MockAdapter().complete({
      model: "mock-1", messages: [{ role: "user", content: "<unit>some text here</unit>" }],
      schema: wide, temperature: 0, maxTokens: 64,
    });
    assert.deepEqual(validateSchema(res.json, wide), []);
  });

  it("agrees with the oracle 100% at accuracy 1.0 (200 units)", async () => {
    const mock = new MockAdapter().setOracle(oracle).setAccuracy(1.0);
    const units = plantedUnits(200);
    const out = await Promise.all(units.map((u) => mock.complete(judgeReq(u.text))));
    const agree = out.filter((r, i) => r.json.label === units[i].theme).length;
    assert.equal(agree, 200);
  });

  it("agrees within [0.7, 0.9] at accuracy 0.8 (500 units)", async () => {
    const mock = new MockAdapter().setOracle(oracle).setAccuracy(0.8);
    const units = plantedUnits(500);
    const out = await Promise.all(units.map((u) => mock.complete(judgeReq(u.text))));
    const rate = out.filter((r, i) => r.json.label === units[i].theme).length / units.length;
    assert.ok(rate >= 0.7 && rate <= 0.9, `agreement ${rate}`);
    // disagreements still emit valid labels
    for (const r of out) assert.ok(THEMES.includes(r.json.label));
  });

  it("confidence skews higher on agreement", async () => {
    const mock = new MockAdapter().setOracle(oracle).setAccuracy(0.5);
    const units = plantedUnits(400);
    const out = await Promise.all(units.map((u) => mock.complete(judgeReq(u.text))));
    const agreeConf = [], disConf = [];
    out.forEach((r, i) => (r.json.label === units[i].theme ? agreeConf : disConf).push(r.json.confidence));
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.ok(agreeConf.length > 50 && disConf.length > 50, "both outcomes well represented");
    assert.ok(mean(agreeConf) > mean(disConf) + 0.05, `agree ${mean(agreeConf).toFixed(3)} vs disagree ${mean(disConf).toFixed(3)}`);
  });

  it("handler hook scripts Director-style responses", async () => {
    const mock = new MockAdapter();
    let seen = null;
    mock.setHandler("brief", (req) => { seen = req; return { sections: [{ md: "# Brief", refs: ["u_1"] }] }; });
    const res = await mock.complete({
      model: "mock-1",
      messages: [
        { role: "system", content: "You are the Director. [[handler:brief]]" },
        { role: "user", content: "Write the brief." },
      ],
      temperature: 0, maxTokens: 500,
    });
    assert.deepEqual(res.json, { sections: [{ md: "# Brief", refs: ["u_1"] }] });
    assert.equal(res.text, JSON.stringify(res.json));
    assert.equal(seen.model, "mock-1");
  });

  it("latency is small and usage tracks chars/3.6 in, maxTokens-ish out", async () => {
    const mock = new MockAdapter();
    const req = judgeReq("The pay is terrible and management ignores us completely.");
    const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const t0 = performance.now();
    const res = await mock.complete(req);
    const dt = performance.now() - t0;
    assert.ok(dt >= 4 && dt < 250, `latency ${dt}ms`);
    assert.ok(Math.abs(res.usage.inputTokens - chars / 3.6) <= chars / 3.6 * 0.1 + 1, `inputTokens ${res.usage.inputTokens} vs chars/3.6 ${chars / 3.6}`);
    assert.ok(res.usage.outputTokens >= 120 * 0.84 && res.usage.outputTokens <= 120 * 1.16, `outputTokens ${res.usage.outputTokens}`);
  });
});

// ---------------------------------------------------------------- costs

describe("costs", () => {
  it("estimateRun arithmetic", () => {
    const est = estimateRun({
      units: Array.from({ length: 10 }, () => "x".repeat(36)),
      template: "t".repeat(144),
      maxTokens: 100,
      pricing: { inUSDper1M: 3, outUSDper1M: 15 },
      callsPerUnit: 2,
    });
    assert.equal(est.calls, 20);
    assert.equal(est.inputTokens, 1000); // 20 × (144+36)/3.6
    assert.equal(est.outputTokens, 2000);
    assert.equal(est.estUSD, 0.033);
    assert.ok(est.etaMinutes > 0);
  });

  it("meter accumulates tokens and dollars", () => {
    const m = meter();
    let t = m.add({ inputTokens: 1_000_000, outputTokens: 0 }, { inUSDper1M: 3, outUSDper1M: 15 });
    assert.deepEqual(t, { inputTokens: 1_000_000, outputTokens: 0, usd: 3 });
    t = m.add({ inputTokens: 0, outputTokens: 200_000 }, { inUSDper1M: 3, outUSDper1M: 15 });
    assert.equal(t.usd, 6);
    assert.deepEqual(m.totals(), { inputTokens: 1_000_000, outputTokens: 200_000, usd: 6 });
  });

  it("checkBudget throws BUDGET_EXCEEDED at/over the cap, never under or capless", () => {
    checkBudget(4.99, 5);
    checkBudget(123, null);
    checkBudget(123, undefined);
    assert.throws(() => checkBudget(5, 5), { code: "BUDGET_EXCEEDED" });
    assert.throws(() => checkBudget(5.01, 5), { code: "BUDGET_EXCEEDED" });
  });

  it("estimateRun lands within ±15% of mock actuals on a 1000-unit corpus", async () => {
    const rng = mulberry32(42);
    const words = ["pay", "shift", "manager", "team", "hours", "respect", "training", "growth", "tired", "schedule", "benefits", "praise"];
    const units = Array.from({ length: 1000 }, () => {
      const n = 8 + Math.floor(rng() * 30);
      return Array.from({ length: n }, () => words[Math.floor(rng() * words.length)]).join(" ");
    });
    const template = "You are a careful judge. Apply the codebook to the unit.\n<unit>{{unit}}</unit>\nReturn JSON with rationale, label, confidence.";
    const maxTokens = 120;

    const est = estimateRun({ units, template, maxTokens, pricing: { inUSDper1M: 0, outUSDper1M: 0 } });
    assert.equal(est.calls, 1000);
    assert.equal(est.estUSD, 0);

    const mock = new MockAdapter().setOracle(() => "pay");
    const m = meter();
    await Promise.all(units.map(async (text) => {
      const res = await mock.complete({
        model: "mock-1",
        messages: [{ role: "user", content: template.replace("{{unit}}", text) }],
        schema: themeSchema, temperature: 0, maxTokens,
      });
      m.add(res.usage, { inUSDper1M: 0, outUSDper1M: 0 });
    }));
    const actual = m.totals();
    assert.equal(actual.usd, 0);
    const inRatio = est.inputTokens / actual.inputTokens;
    const outRatio = est.outputTokens / actual.outputTokens;
    assert.ok(inRatio > 0.85 && inRatio < 1.15, `input est/actual = ${inRatio.toFixed(3)}`);
    assert.ok(outRatio > 0.85 && outRatio < 1.15, `output est/actual = ${outRatio.toFixed(3)}`);
  });
});
