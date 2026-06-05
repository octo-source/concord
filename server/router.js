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

// SSE connection helper. The returned handle knows when the client is gone:
// `closed` flips and onClose callbacks fire on req "close" (disconnects and
// normal ends alike), so long-lived producers can stop pushing.
export function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.flushHeaders?.();
  const closeHandlers = [];
  const conn = {
    closed: false,
    send(event, data) {
      if (conn.closed || res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (!res.writableEnded && !res.destroyed) res.end();
    },
    onClose(fn) {
      if (conn.closed) fn();
      else closeHandlers.push(fn);
    },
  };
  res.req?.on("close", () => {
    if (conn.closed) return;
    conn.closed = true;
    for (const fn of closeHandlers.splice(0)) fn();
  });
  return conn;
}

const MULTIPART_DEFAULTS = { maxFileSize: 200 * 1024 * 1024, maxFiles: 10, maxFields: 200 };

export function parseMultipart(req, { maxFileSize = MULTIPART_DEFAULTS.maxFileSize, maxFiles = MULTIPART_DEFAULTS.maxFiles, maxFields = MULTIPART_DEFAULTS.maxFields } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bb;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (bb) req.unpipe(bb);
      reject(err);
    };
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: maxFileSize, files: maxFiles, fields: maxFields } });
    } catch (err) {
      return fail(new ConcordError("BAD_MULTIPART", err.message));
    }
    const fields = {};
    const files = [];
    bb.on("field", (name, value) => {
      fields[name] = value;
    });
    bb.on("file", (name, stream, info) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("limit", () => {
        stream.resume(); // discard the rest so busboy does not wedge
        fail(new ConcordError("TOO_LARGE", `Uploaded file exceeds ${maxFileSize} bytes`, { filename: info.filename }));
      });
      stream.on("end", () => {
        if (!stream.truncated) files.push({ name, filename: info.filename, buffer: Buffer.concat(chunks) });
      });
    });
    bb.on("filesLimit", () => fail(new ConcordError("TOO_LARGE", `More than ${maxFiles} files in upload`)));
    bb.on("fieldsLimit", () => fail(new ConcordError("TOO_LARGE", `More than ${maxFields} fields in upload`)));
    bb.on("error", (err) => fail(new ConcordError("BAD_MULTIPART", err.message, {}, { cause: err })));
    bb.on("close", () => done({ fields, files }));
    // a client that vanishes mid-upload must settle the promise, not hang it
    req.on("aborted", () => fail(new ConcordError("BAD_MULTIPART", "Request aborted mid-upload")));
    req.on("error", (err) => fail(new ConcordError("BAD_MULTIPART", err.message, {}, { cause: err })));
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

// HTTP status per ConcordError code; an explicit err.status always wins and
// anything unlisted falls back to 400.
const ERROR_STATUS = {
  NOT_FOUND: 404,
  TOO_LARGE: 413,
  PRIVACY_BLOCKED: 403,
  RATE_LIMITED_EXHAUSTED: 503,
  VALIDATION: 400,
  BAD_JSON: 400,
  SCHEMA_INVALID: 400,
  CONFIG_MISSING: 400,
};

export function createRouter({ appDir, maxJsonBody = DEFAULT_MAX_JSON_BODY, fsImpl } = {}) {
  // fs seam: tests inject stat/createReadStream to reproduce stat->open races
  const sfs = { stat, createReadStream, ...fsImpl };
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
    if (res.destroyed) return; // client is gone — nowhere to send anything
    if (res.headersSent) {
      // already streaming (SSE/static) — nothing sensible to send
      res.end();
      return;
    }
    if (err instanceof ConcordError) {
      const status = err.status ?? ERROR_STATUS[err.code] ?? 400;
      sendJson(res, status, { ok: false, error: { code: err.code, message: err.message } });
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
      info = await sfs.stat(file);
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
    const stream = sfs.createReadStream(file);
    // a read error (file deleted/locked between stat and open, Dropbox sync
    // locks, mid-read I/O failure) must kill THIS response, not the process;
    // headers are already sent, so destroying the socket is all that is left
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy()); // client gone — stop reading
    stream.pipe(res);
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
        if (!res.destroyed && !res.headersSent && !res.writableEnded) sendJson(res, 200, { ok: true, data: data ?? null });
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
