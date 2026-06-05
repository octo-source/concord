// HTTP plumbing: route table with :param segments, JSON body parsing with a
// size cap, the {ok, data|error} envelope, multipart + SSE helpers, and
// static file serving from app/. Plain node:http — no framework.
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import busboy from "busboy";
import { ConcordError } from "./core/errors.js";

const DEFAULT_MAX_JSON_BODY = 50 * 1024 * 1024;

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

export function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders?.();
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      res.end();
    },
  };
}

export function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers });
    } catch (err) {
      return reject(new ConcordError("BAD_MULTIPART", err.message));
    }
    const fields = {};
    const files = [];
    bb.on("field", (name, value) => {
      fields[name] = value;
    });
    bb.on("file", (name, stream, info) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => files.push({ name, filename: info.filename, buffer: Buffer.concat(chunks) }));
    });
    bb.on("error", (err) => reject(new ConcordError("BAD_MULTIPART", err.message)));
    bb.on("close", () => resolve({ fields, files }));
    req.pipe(bb);
  });
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return; // already over limit — keep draining so the 400 can be delivered
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new ConcordError("TOO_LARGE", `JSON body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (size === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ConcordError("BAD_JSON", "Request body is not valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

export function createRouter({ appDir, maxJsonBody = DEFAULT_MAX_JSON_BODY } = {}) {
  const routes = [];

  function addRoute(method, pattern, handler) {
    routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter(Boolean),
      pattern,
      handler,
    });
  }

  function match(method, pathname) {
    let parts;
    try {
      parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return null; // bad percent-escape — no route can match
    }
    for (const route of routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params = {};
      let hit = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(":")) params[seg.slice(1)] = parts[i];
        else if (seg !== parts[i]) { hit = false; break; }
      }
      if (hit) return { route, params };
    }
    return null;
  }

  function sendError(res, err) {
    if (res.headersSent) {
      // already streaming (SSE/static) — nothing sensible to send
      res.end();
      return;
    }
    if (err instanceof ConcordError) {
      sendJson(res, 400, { ok: false, error: { code: err.code, message: err.message } });
    } else {
      console.error(err);
      sendJson(res, 500, { ok: false, error: { code: "INTERNAL", message: err.message || "Internal error" } });
    }
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 404, "Not found");
    if (!appDir) return sendText(res, 404, "Not found");
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 404, "Not found");
    }
    const isRoot = rel === "/";
    if (isRoot) rel = "/index.html";
    const base = path.resolve(appDir);
    const file = path.resolve(base, "." + rel);
    if (!file.startsWith(base + path.sep)) return sendText(res, 404, "Not found");
    let info;
    try {
      info = await stat(file);
    } catch {
      if (isRoot) return sendText(res, 503, "UI not built");
      return sendText(res, 404, "Not found");
    }
    if (!info.isFile()) return sendText(res, 404, "Not found");
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": info.size,
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return sendText(res, 400, "Bad request");
    }
    req.query = Object.fromEntries(url.searchParams);
    const found = match(req.method, url.pathname);
    if (found) {
      try {
        if ((req.headers["content-type"] || "").includes("application/json")) {
          req.body = await readJsonBody(req, maxJsonBody);
        }
        const data = await found.route.handler(req, res, found.params);
        // handlers that stream (SSE, files) finish the response themselves
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, { ok: true, data: data ?? null });
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `No route ${req.method} ${url.pathname}` } });
    }
    try {
      await serveStatic(req, res, url.pathname);
    } catch (err) {
      sendError(res, err);
    }
  }

  return { addRoute, handle, routes };
}
