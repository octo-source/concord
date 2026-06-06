// Concord server entry point. Builds the router, mounts route modules from
// server/routes/, serves the UI from app/, and exposes startServer() so tests
// can spin up an ephemeral instance (port 0).
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createRouter, sendJson } from "./router.js";
import { ConcordError } from "./core/errors.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// --coder <goldsetId>:<coderId> launches a blind coding profile. The route
// gate itself lands with the goldset routes; here we only parse + export.
export function parseServerMode(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--coder");
  if (i === -1) return { role: "full" };
  const spec = argv[i + 1] ?? "";
  const m = /^([^:]+):(.+)$/.exec(spec);
  if (!m) throw new ConcordError("VALIDATION", "--coder requires <goldsetId>:<coderId>", { got: spec });
  return { role: "coder", goldsetId: m[1], coderId: m[2] };
}

export const serverMode = parseServerMode();

export async function readPort(configPath = path.join(repoRoot, "config", "app.json")) {
  try {
    const cfg = JSON.parse(await readFile(configPath, "utf8"));
    if (Number.isInteger(cfg.port) && cfg.port >= 0 && cfg.port <= 65535) return cfg.port;
  } catch {
    // missing config dir/file or malformed JSON — fall through to default
  }
  return 7341;
}

async function mountRoutes(router, dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return; // routes land in a later task
    throw err;
  }
  for (const name of entries.filter((f) => f.endsWith(".js")).sort()) {
    const mod = await import(pathToFileURL(path.join(dir, name)).href);
    if (!Array.isArray(mod.default)) {
      throw new ConcordError("ROUTES", `Route module ${name} must default-export an array of {method, pattern, handler}`, { file: name });
    }
    for (const { method, pattern, handler } of mod.default) router.addRoute(method, pattern, handler);
  }
}

// Boot-time orphan sweep (see call site below). Lives here because index.js
// owns process lifecycle; the monitor route heals the same condition lazily
// for any record this sweep misses (e.g. a bundle synced in after boot).
async function healOrphanedRuns() {
  const { listProjects, updateProject } = await import("./core/store.js");
  for (const entry of await listProjects()) {
    if (!entry || entry.corrupt || !entry.slug) continue;
    try {
      await updateProject(entry.slug, (p) => {
        for (const r of p.runs ?? []) {
          if (r.status === "running") {
            r.status = "paused";
            r.error = {
              code: "ORPHANED",
              message: "the server stopped while this run was executing; resume continues from the checkpoint",
            };
          }
        }
      });
    } catch { /* one damaged bundle must not block the rest */ }
  }
}

export async function startServer({
  port = 7341,
  appDir = path.join(repoRoot, "app"),
  routesDir = path.join(repoRoot, "server", "routes"),
} = {}) {
  const router = createRouter({ appDir });
  const version = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version;

  router.addRoute("GET", "/api/health", async (req, res) => {
    // provider reachability lives with the routes layer (configured keys /
    // local discovery / mock); absent routes the stub map still answers
    let providers = {};
    try {
      const { providerHealth } = await import("./routes/catalog.js");
      providers = await providerHealth();
    } catch {
      // routes not built yet — health stays minimal
    }
    sendJson(res, 200, { ok: true, version, providers });
  });

  await mountRoutes(router, routesDir);

  const server = http.createServer((req, res) => {
    router.handle(req, res).catch((err) => {
      console.error(err);
      if (!res.writableEnded) {
        try { res.statusCode = 500; res.end(); } catch { /* socket gone */ }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  // `localhost` resolves to ::1 FIRST on Windows; some HTTP clients try only
  // the first answer. Mirror the listener on IPv6 loopback (same port, same
  // router) so localhost works regardless of resolver order. Best-effort —
  // machines without IPv6 simply skip it.
  const boundPort = server.address().port;
  let server6 = null;
  try {
    server6 = http.createServer((req, res) => {
      router.handle(req, res).catch((err) => {
        console.error(err);
        if (!res.writableEnded) {
          try { res.statusCode = 500; res.end(); } catch { /* socket gone */ }
        }
      });
    });
    await new Promise((resolve, reject) => {
      server6.once("error", reject);
      server6.listen(boundPort, "::1", resolve);
    });
  } catch {
    server6 = null; // no IPv6 loopback — IPv4 alone is fine
  }

  // Heal orphaned runs: a record still saying "running" at boot belongs to a
  // process that no longer exists (restart/crash mid-run). Mark it paused —
  // resume is exactly-once off the outputs on disk — so the UI never watches
  // a runner that is not there. Best-effort; never blocks startup.
  healOrphanedRuns().catch(() => {});

  return {
    server,
    router,
    port: boundPort,
    close: () => new Promise((resolve) => {
      let pending = server6 ? 2 : 1;
      const one = () => { if (--pending === 0) resolve(); };
      server.close(one);
      server.closeAllConnections?.();
      if (server6) {
        server6.close(one);
        server6.closeAllConnections?.();
      }
    }),
  };
}

// Same-process restricted listener for one blind coder (the recorded design
// decision: ONE process writes a bundle — the coder profile is a role inside
// THIS server process on its own ephemeral port, never a second writer).
// Serves ONLY static files plus GET /api/coder/next, POST /api/coder/label,
// GET /api/coder/progress for the bound (project, goldset, coder). The
// restricted handlers live in routes/goldsets.js and never expose machine
// labels or other coders' labels.
export async function startCoderListener(projectSlug, goldsetId, coderId, {
  appDir = path.join(repoRoot, "app"),
} = {}) {
  if (!projectSlug || !goldsetId || !coderId) {
    throw new ConcordError("VALIDATION", "startCoderListener requires projectSlug, goldsetId and coderId", {});
  }
  const { coderRoutes } = await import("./routes/goldsets.js");
  const router = createRouter({ appDir });
  for (const { method, pattern, handler } of coderRoutes(projectSlug, goldsetId, coderId)) {
    router.addRoute(method, pattern, handler);
  }
  const server = http.createServer((req, res) => {
    router.handle(req, res).catch(() => {
      if (!res.writableEnded) {
        try { res.statusCode = 500; res.end(); } catch { /* socket gone */ }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    coderId,
    goldsetId,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = await readPort();
  try {
    const { port: actual } = await startServer({ port });
    console.log(`Concord listening on http://localhost:${actual}`);
    console.log(`Blind coder sessions are started from the Calibration Studio, never from the command line.`);
  } catch (err) {
    if (err?.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use — is Concord already running? Close it or change the port in config/app.json.`);
    } else {
      console.error(`Concord failed to start: ${err?.message ?? err}`);
    }
    process.exitCode = 1;
  }
}
