// The human coder screen and its restricted listener — the contract behind
// the coder-session URL:
//
//   a. SERVED PAGE: a coder session's URL points at /coder.html?coder=<id>;
//      the listener serves that page (and its module) from the app dir, and
//      the page drives /api/coder/* only.
//   b. RESTRICTED SURFACE: /api/coder/next answers with the blind payload for
//      the BOUND coder (no machine labels, no other coder, no adjudicated
//      answer in the bytes); /api/projects/* — the unblinded API — 404s.
//   c. HOST OPT-IN: the listener binds 127.0.0.1 unless the researcher
//      explicitly opts into "0.0.0.0"; only the shared listener answers
//      requests addressed to a LAN host, and only the shared session carries
//      a lanUrl (when the machine has an external IPv4 at all).
//   d. WRITE PATH: a label submitted through the listener lands in the gold
//      set artifact under the BOUND coder id — a body-supplied coder id is
//      ignored.
//
// Harness mirrors tests/server/gold-integrity.test.js: real server on an
// ephemeral port over temp CONCORD_PROJECTS_DIR/CONCORD_CONFIG_DIR; tests run
// serially in declaration order and share state via S.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { startServer, startCoderListener } from "../../server/index.js";

// ---------------------------------------------------------------- harness

let tmpProjects;
let tmpConfig;
let srv;
let base;

before(async () => {
  tmpProjects = await mkdtemp(path.join(os.tmpdir(), "concord-coderscreen-"));
  tmpConfig = await mkdtemp(path.join(os.tmpdir(), "concord-coderscreen-cfg-"));
  process.env.CONCORD_PROJECTS_DIR = tmpProjects;
  process.env.CONCORD_CONFIG_DIR = tmpConfig;
  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  // close any listener a failing test left behind, then the server
  for (const h of S.toClose.splice(0)) await h.close().catch(() => {});
  await srv.close();
  delete process.env.CONCORD_PROJECTS_DIR;
  delete process.env.CONCORD_CONFIG_DIR;
  await rm(tmpProjects, { recursive: true, force: true }).catch(() => {});
  await rm(tmpConfig, { recursive: true, force: true }).catch(() => {});
});

async function call(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (static files) */
  }
  return { status: res.status, json, text, type: res.headers.get("content-type") ?? "" };
}

async function ok(method, p, body) {
  const r = await call(method, base + p, body);
  assert.equal(r.status, 200, `${method} ${p} → ${r.status}: ${r.text?.slice(0, 300)}`);
  assert.equal(r.json?.ok, true, `${method} ${p} envelope not ok`);
  return r.json.data;
}

async function upload(p, filename, content) {
  const form = new FormData();
  form.append("file", new Blob([content]), filename);
  const res = await fetch(base + p, { method: "POST", body: form });
  const json = JSON.parse(await res.text());
  assert.equal(
    res.status,
    200,
    `upload ${p} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`,
  );
  return json.data;
}

function makeCsv(n = 30) {
  const lines = ["respondent_id,response"];
  for (let i = 0; i < n; i++) {
    const text =
      i % 2 === 0
        ? `the salary is too low for this work and it never improves around here (${i})`
        : `the office is comfortable and the team is genuinely kind to everyone (${i})`;
    lines.push(`r${i},${text}`);
  }
  return lines.join("\n") + "\n";
}

/** Same selection the listener uses: first non-internal IPv4 on the machine. */
function firstLanIPv4() {
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const net of ifs ?? []) {
      if (!net.internal && (net.family === "IPv4" || net.family === 4)) return net.address;
    }
  }
  return null;
}

/** first "t=" query param on a coder-session url — the listener's token. */
function tokenOf(url) {
  return new URL(url).searchParams.get("t");
}

/** GET over loopback with a CHOSEN Host header (fetch refuses to forge one). */
function rawGet(port, pathname, hostHeader, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        headers: { host: hostHeader, ...extraHeaders },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ------------------------------------------------------------ shared state

const S = {
  slug: null,
  corpusId: null,
  constructId: null,
  gsId: null,
  units: [], // sampled unitIds in order
  listenerUrl: null, // base of pat's listener (no path)
  token: null, // pat's listener's x-coder-token
  toClose: [], // listener handles to close in after()
};

const G = (rest = "") => `/api/projects/${S.slug}/goldsets${rest}`;
const goldsetArtifact = () => path.join(tmpProjects, S.slug, "gold", `${S.gsId}.json`);

// ---------------------------------------------------------------- the tests

test("setup: project + corpus + construct + sampled gold set, with planted unblinded data", async () => {
  const project = await ok("POST", "/api/projects", { name: "Coder Screen", privacyMode: "open" });
  S.slug = project.slug;

  const up = await upload(`/api/projects/${S.slug}/import`, "survey.csv", makeCsv());
  const confirmed = await ok("POST", `/api/projects/${S.slug}/import/confirm`, {
    importId: up.importId,
    mapping: { textColumn: "response" },
    unitization: { scheme: "response" },
  });
  S.corpusId = confirmed.corpusId;

  const construct = await ok("POST", `/api/projects/${S.slug}/constructs`, {
    name: "Pay complaint",
    type: "binary",
    definition: "The unit complains about compensation level or fairness.",
    criteria: {
      include: ["names compensation as a problem"],
      exclude: ["benefits-only complaints"],
    },
    edgeCases: ["sarcastic praise of pay counts as a complaint"],
    examples: [{ text: "What they pay us is insulting.", label: "yes", kind: "positive" }],
    categories: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  });
  S.constructId = construct.id;

  const gs = await ok("POST", G(), { constructId: S.constructId, corpusId: S.corpusId });
  S.gsId = gs.id;
  const sampled = await ok("POST", G(`/${gs.id}/sample`), { design: "srs", n: 5 });
  S.units = sampled.sample.map((s) => s.unitId);

  // plant what must NOT leak through the listener: a rival coder's label and
  // an adjudicated gold answer on the unit the session coder sees first
  await ok("POST", G(`/${gs.id}/label`), { coder: "rival", unitId: S.units[0], label: "yes" });
  await ok("POST", G(`/${gs.id}/adjudicate`), { unitId: S.units[0], label: "yes" });
});

// =========================================================================
// a — the session URL serves the page
// =========================================================================

test("coder session: the URL points at /coder.html?coder=<id>; the listener serves the page and its module, which drives /api/coder/*", async () => {
  const session = await ok("POST", G(`/${S.gsId}/coder-session`), { coderId: "pat" });
  assert.ok(session.url.startsWith("http://127.0.0.1:"), `localhost url (got ${session.url})`);
  assert.ok(
    session.url.includes("/coder.html?coder=pat&t="),
    `session url is the coding page (got ${session.url})`,
  );
  S.listenerUrl = `http://127.0.0.1:${session.port}`;
  S.token = tokenOf(session.url);
  assert.ok(S.token, "the session carries a coder token");

  const page = await call("GET", `${S.listenerUrl}/coder.html`);
  assert.equal(page.status, 200, `GET /coder.html → ${page.status}`);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /js\/coder\.js/, "the page loads its module with a relative path");
  assert.ok(!/src="\/js\/coder\.js"/.test(page.text), "module path is relative, not absolute");
  assert.match(
    page.text.toLowerCase(),
    /you cannot see other coders/,
    "the page states the blind contract",
  );

  const mod = await call("GET", `${S.listenerUrl}/js/coder.js`);
  assert.equal(mod.status, 200, `GET /js/coder.js → ${mod.status}`);
  assert.match(mod.text, /\/api\/coder\/next/, "the module reads the blind next route");
  assert.match(mod.text, /\/api\/coder\/label/, "the module submits through the blind label route");
  assert.ok(!mod.text.includes("/api/projects"), "the module never touches the unblinded API");
});

// =========================================================================
// b — the restricted surface: blind payload in, everything else 404
// =========================================================================

test("listener API: a missing or wrong x-coder-token is refused (403) before any gold data is touched", async () => {
  const noToken = await call("GET", `${S.listenerUrl}/api/coder/next`);
  assert.equal(noToken.status, 403, `no token → ${noToken.status}: ${noToken.text?.slice(0, 200)}`);

  const wrongToken = await call("GET", `${S.listenerUrl}/api/coder/next`, undefined, {
    "x-coder-token": "not-the-real-token",
  });
  assert.equal(wrongToken.status, 403, `wrong token → ${wrongToken.status}`);
});

test("listener API: /api/coder/next is blind for the bound coder; /api/projects/* and /api/health do not exist here", async () => {
  const r = await call("GET", `${S.listenerUrl}/api/coder/next`, undefined, {
    "x-coder-token": S.token,
  });
  assert.equal(r.status, 200, r.text?.slice(0, 300));
  assert.equal(r.json?.ok, true);
  const data = r.json.data;
  assert.deepEqual(
    Object.keys(data).sort(),
    ["construct", "progress", "unit"],
    "lean one-unit contract",
  );
  assert.deepEqual(
    Object.keys(data.unit).sort(),
    ["id", "pos", "text"],
    "unit is id/text/pos only",
  );
  assert.equal(
    data.unit.id,
    S.units[0],
    "pat starts at the first sampled unit despite rival's progress",
  );
  assert.equal(data.progress.coderId, "pat");
  assert.deepEqual(
    data.construct.categories.map((c) => c.value),
    ["yes", "no"],
  );
  for (const marker of [
    '"juror"',
    '"machine',
    '"adjudicated"',
    '"labels"',
    '"rationale"',
    '"confidence"',
    "rival",
  ]) {
    assert.ok(
      !r.text.includes(marker),
      `blind payload must not contain ${marker}: ${r.text.slice(0, 400)}`,
    );
  }

  for (const p of ["/api/projects", `/api/projects/${S.slug}/goldsets/${S.gsId}`, "/api/health"]) {
    const blocked = await call("GET", `${S.listenerUrl}${p}`);
    assert.equal(
      blocked.status,
      404,
      `${p} must not exist on the coder listener (got ${blocked.status})`,
    );
  }
});

// =========================================================================
// d — the write path: labels land under the bound coder
// =========================================================================

test("label through the listener: lands in the gold set under the bound coder; a body-supplied coder id is ignored", async () => {
  const r = await call(
    "POST",
    `${S.listenerUrl}/api/coder/label`,
    {
      unitId: S.units[0],
      label: "no",
      memo: "borderline",
      flag: true,
      coder: "intruder", // must be ignored — the listener binds pat
    },
    { "x-coder-token": S.token },
  );
  assert.equal(r.status, 200, r.text?.slice(0, 300));
  assert.equal(r.json.data.done, 1);

  const artifact = JSON.parse(await readFile(goldsetArtifact(), "utf8"));
  const pat = (artifact.coders ?? []).find((c) => c.coderId === "pat");
  assert.ok(pat, "pat exists on the artifact");
  assert.equal(pat.labels[S.units[0]], "no");
  assert.equal(pat.memos[S.units[0]], "borderline");
  assert.ok(pat.flagged.includes(S.units[0]));
  assert.ok(
    !(artifact.coders ?? []).some((c) => c.coderId === "intruder"),
    "the body's coder id never becomes a coder",
  );

  const next = await call("GET", `${S.listenerUrl}/api/coder/next`, undefined, {
    "x-coder-token": S.token,
  });
  assert.equal(next.json.data.progress.done, 1);
  assert.equal(next.json.data.unit.id, S.units[1], "the queue advanced past the labeled unit");

  await ok("DELETE", G(`/${S.gsId}/coder-session?coderId=pat`));
});

// =========================================================================
// c — host opt-in: loopback default, 0.0.0.0 by explicit choice
// =========================================================================

test("host default: the listener binds 127.0.0.1, carries no lanUrl, and refuses a foreign Host header", async () => {
  const h = await startCoderListener(S.slug, S.gsId, "local-only");
  S.toClose.push(h);
  assert.equal(h.server.address().address, "127.0.0.1", "default binding is loopback");
  assert.equal(h.lanUrl, undefined, "a loopback listener has no LAN url");
  assert.ok(h.url.includes("/coder.html?coder=local-only&t="));

  const foreign = await rawGet(h.port, "/api/coder/next", "192.168.50.50", {
    "x-coder-token": tokenOf(h.url),
  });
  assert.equal(foreign.status, 403, "the rebinding guard stays armed on the loopback listener");
  await h.close();
  S.toClose.pop();
});

test("host opt-in: {host: '0.0.0.0'} binds all interfaces, answers LAN-addressed requests, and reports a lanUrl when an external IPv4 exists", async () => {
  const h = await startCoderListener(S.slug, S.gsId, "lan-coder", { host: "0.0.0.0" });
  S.toClose.push(h);
  assert.equal(h.server.address().address, "0.0.0.0", "opt-in binds all interfaces");
  const token = tokenOf(h.url);

  // a LAN client addresses the machine by its LAN ip — the shared listener
  // must answer that Host, not 403 it (given the right token)
  const foreign = await rawGet(h.port, "/api/coder/next", `192.168.50.50:${h.port}`, {
    "x-coder-token": token,
  });
  assert.equal(
    foreign.status,
    200,
    `shared listener answers a LAN host (got ${foreign.status}: ${foreign.body.slice(0, 200)})`,
  );

  // a LAN neighbor without the session link — right host, no token — is refused
  const noToken = await rawGet(h.port, "/api/coder/next", `192.168.50.50:${h.port}`);
  assert.equal(noToken.status, 403, "a LAN request without the token is refused");

  const lan = firstLanIPv4();
  if (lan) {
    assert.equal(
      h.lanUrl,
      `http://${lan}:${h.port}/coder.html?coder=lan-coder&t=${token}`,
      "lanUrl is built from the first non-internal IPv4",
    );
  } else {
    assert.equal(h.lanUrl, undefined, "no external IPv4 — no lanUrl to hand out");
  }
  await h.close();
  S.toClose.pop();
});

test("share through the session route: {share: true} yields a lanUrl (when the machine has an external IPv4); teardown closes it", async () => {
  const session = await ok("POST", G(`/${S.gsId}/coder-session`), { coderId: "sam", share: true });
  assert.ok(session.url.includes("/coder.html?coder=sam&t="));
  const lan = firstLanIPv4();
  if (lan) {
    assert.equal(
      session.lanUrl,
      `http://${lan}:${session.port}/coder.html?coder=sam&t=${tokenOf(session.url)}`,
    );
  } else {
    assert.equal(
      session.lanUrl,
      undefined,
      "no external IPv4 on this machine — assertion skipped gracefully",
    );
  }
  const closed = await ok("DELETE", G(`/${S.gsId}/coder-session?coderId=sam`));
  assert.equal(closed.closed, 1);
});
