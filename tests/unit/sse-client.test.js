// The client side of the SSE contract: server routes report terminal failures
// as an `event: error` inside a 200 stream (see server/routes/brief.js). The
// client MUST surface that to onError — a dropped error event leaves screens
// composing forever ("reading a stratified sample…", June 2026 field bug).
import { test } from "node:test";
import assert from "node:assert/strict";

const api = await import("../../app/js/api.js");

// Build a Response whose body replays pre-baked SSE frames.
function sseResponse(frames) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = orig; });
}

const errorFrame = (code, message) =>
  `event: error\ndata: ${JSON.stringify({ code, message })}\n\n`;

test("sse client: a server `error` event reaches onError (not the floor) — brief", async () => {
  await withFetch(async () => sseResponse([errorFrame("TRUNCATED", "raise maxTokens")]), async () => {
    const got = { error: null, done: false, paras: 0, closed: false };
    api.brief.generate("p", "c", {
      onParagraph: () => { got.paras++; },
      onDone: () => { got.done = true; },
      onClose: () => { got.closed = true; },
      onError: (err) => { got.error = err; },
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(got.error, "onError must fire for a streamed error event");
    assert.equal(got.error.code, "TRUNCATED");
    assert.match(got.error.message, /maxTokens/);
    assert.equal(got.done, false, "a failed stream must not look like success");
    assert.equal(got.paras, 0);
  });
});

test("sse client: silver-tune and monitor error events also reach onError", async () => {
  for (const start of [
    (h) => api.instruments.silverTune("p", "i", {}, h),
    (h) => api.runs.monitor("p", "r", h),
  ]) {
    await withFetch(async () => sseResponse([errorFrame("PRIVACY_BLOCKED", "openrouter requires a justification")]), async () => {
      const got = { error: null, done: false };
      start({ onDone: () => { got.done = true; }, onError: (e) => { got.error = e; } });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(got.error?.code, "PRIVACY_BLOCKED");
      assert.equal(got.done, false);
    });
  }
});

test("sse client: healthy streams still deliver events then done", async () => {
  const frames = [
    `event: para\ndata: ${JSON.stringify({ md: "First.", refs: ["u_1"] })}\n\n`,
    `event: para\ndata: ${JSON.stringify({ md: "Second.", refs: [] })}\n\n`,
    `event: done\ndata: ${JSON.stringify({ briefId: "brief_x" })}\n\n`,
  ];
  await withFetch(async () => sseResponse(frames), async () => {
    const got = { paras: [], done: null, error: null };
    api.brief.generate("p", "c", {
      onParagraph: (p) => got.paras.push(p.md),
      onDone: (d) => { got.done = d; },
      onError: (e) => { got.error = e; },
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(got.paras, ["First.", "Second."]);
    assert.equal(got.done?.briefId, "brief_x");
    assert.equal(got.error, null);
  });
});
