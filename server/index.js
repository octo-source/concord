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

export async function startServer({
  port = 7341,
  appDir = path.join(repoRoot, "app"),
  routesDir = path.join(repoRoot, "server", "routes"),
} = {}) {
  const router = createRouter({ appDir });
  const version = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")).version;

  router.addRoute("GET", "/api/health", async (req, res) => {
    sendJson(res, 200, { ok: true, version, providers: {} });
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

  return {
    server,
    router,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      // live SSE/keep-alive connections would hold close() open forever
      server.closeAllConnections?.();
    }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = await readPort();
  const { port: actual } = await startServer({ port });
  const suffix = serverMode.role === "coder" ? ` — coder profile: ${serverMode.coderId} on ${serverMode.goldsetId}` : "";
  console.log(`Concord listening on http://localhost:${actual}${suffix}`);
}
