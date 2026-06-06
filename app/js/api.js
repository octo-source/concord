// Typed fetch wrappers for every Concord server route, one namespace per
// domain. All JSON routes share the envelope {ok:true, data} | {ok:false,
// error:{code,message}}: wrappers resolve with `data` or throw ApiError.
//
// STREAMING — sseSubscribe() parses text/event-stream over fetch() with a
// ReadableStream, NOT EventSource: EventSource can only issue GETs, and the
// Brief route (POST /api/projects/:p/brief) and silver-tune stream over POST.
// One implementation serves GET streams (run monitor) identically, with the
// added benefits of envelope-aware error handling on non-2xx and AbortController
// cancellation. Parser handles CRLF, multi-line `data:` fields, comment lines,
// and dispatches on the `event:` field name.

export class ApiError extends Error {
  constructor(code, message, { status = 0, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let baseUrl = ""; // same origin; settable for tests/galleries
export function setBase(url) {
  baseUrl = String(url || "").replace(/\/$/, "");
}

function qs(params) {
  if (!params) return "";
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (pairs.length === 0) return "";
  return "?" + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

async function request(method, path, { body, query, multipart } = {}) {
  const url = baseUrl + path + qs(query);
  const init = { method, headers: {} };
  if (multipart) {
    init.body = multipart; // FormData — browser sets the boundary header
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError("UNREACHABLE", `Concord server unreachable (${err.message})`, { status: 0 });
  }
  let envelope = null;
  const text = await res.text();
  if (text) {
    try { envelope = JSON.parse(text); } catch { /* non-JSON body below */ }
  }
  // standard envelope is {ok:true, data}; health responds {ok:true, version,
  // providers} with no data member — hand the whole body back in that case
  if (envelope && envelope.ok === true) {
    return "data" in envelope ? envelope.data : envelope;
  }
  if (envelope && envelope.ok === false && envelope.error) {
    throw new ApiError(envelope.error.code || "ERROR", envelope.error.message || "Request failed", {
      status: res.status, details: envelope.error,
    });
  }
  if (!res.ok) {
    throw new ApiError("HTTP_" + res.status, `${method} ${path} → ${res.status}`, { status: res.status });
  }
  return envelope ?? text; // tolerant of bare-JSON or text endpoints
}

const get_ = (path, opts) => request("GET", path, opts);
const post = (path, body, opts) => request("POST", path, { body, ...opts });
const put = (path, body) => request("PUT", path, { body });
const del = (path) => request("DELETE", path);

/* ---- SSE over fetch -------------------------------------------------------
 * sseSubscribe(url, { method="GET", body, onEvent, onDone, onError })
 *   → { close() } — close() aborts the stream silently (no onError/onDone).
 *
 * onEvent(eventName, data)  every event; data JSON-parsed when possible
 * onDone()                  stream ended cleanly (server closed it)
 * onError(ApiError)         network failure or non-2xx response
 * ------------------------------------------------------------------------- */
export function sseSubscribe(url, { method = "GET", body, onEvent, onDone, onError } = {}) {
  const ctrl = new AbortController();
  let closed = false;

  (async () => {
    let res;
    try {
      const init = { method, signal: ctrl.signal, headers: { accept: "text/event-stream" } };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      res = await fetch(baseUrl + url, init);
    } catch (err) {
      if (!closed) onError?.(new ApiError("UNREACHABLE", `Stream unreachable (${err.message})`, { status: 0 }));
      return;
    }
    if (!res.ok) {
      // mutating SSE routes report failures through the JSON envelope
      let code = "HTTP_" + res.status, message = `${method} ${url} → ${res.status}`;
      try {
        const envelope = JSON.parse(await res.text());
        if (envelope?.error) { code = envelope.error.code; message = envelope.error.message; }
      } catch { /* keep the HTTP framing */ }
      if (!closed) onError?.(new ApiError(code, message, { status: res.status }));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failed = false; // a streamed `error` event is terminal — suppress onDone
    const dispatch = (block) => {
      let event = "message";
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;            // comment / keep-alive
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length === 0) return;
      const rawData = data.join("\n");
      let parsed = rawData;
      try { parsed = JSON.parse(rawData); } catch { /* plain-text data event */ }
      // Server convention (every Concord SSE route): a terminal failure inside
      // an open 200 stream arrives as `event: error` with {code, message}.
      // Surface it through onError CENTRALLY so no wrapper or screen can drop
      // it — a swallowed error event leaves the UI composing forever.
      if (event === "error") {
        failed = true;
        if (!closed) {
          onError?.(new ApiError(parsed?.code ?? "STREAM_ERROR",
            parsed?.message ?? "the stream reported an error", { status: 200, details: parsed }));
        }
        return;
      }
      onEvent?.(event, parsed);
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
          if (block.trim()) dispatch(block);
        }
      }
      if (buffer.trim()) dispatch(buffer);
      if (!closed && !failed) onDone?.();
    } catch (err) {
      if (!closed && !failed) onError?.(new ApiError("STREAM_BROKEN", `Stream interrupted (${err.message})`, { status: 0 }));
    }
  })();

  return {
    close() {
      closed = true;
      ctrl.abort();
    },
  };
}

/* ---- domains -------------------------------------------------------------- */

const P = (p) => `/api/projects/${encodeURIComponent(p)}`;

export const projects = {
  list: () => get_("/api/projects"),
  create: ({ name, privacyMode }) => post("/api/projects", { name, privacyMode }),
  get: (p) => get_(P(p)),
  /** Project-scoped settings: {privacyMode?, confirmDowngrade?, budget?: {capUSD}}. */
  update: (p, body) => put(P(p), body),
};

export const imports = {
  /** Upload a source file. `file` is a File/Blob; extra fields optional. */
  upload(p, file, fields = {}) {
    const form = new FormData();
    form.append("file", file, file.name ?? "upload");
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return request("POST", `${P(p)}/import`, { multipart: form });
  },
  confirm: (p, { mapping, unitization }) => post(`${P(p)}/import/confirm`, { mapping, unitization }),
};

export const corpora = {
  /** Units page: { offset, limit, q, ...metaFilters } */
  units: (p, c, params = {}) => get_(`${P(p)}/corpora/${encodeURIComponent(c)}/units`, { query: params }),
  instantRead: (p, c) => get_(`${P(p)}/corpora/${encodeURIComponent(c)}/instantread`),
  /**
   * The corpus's real metadata columns → {columns: [{name, role, distinct,
   * missing, values?: [{value, n}]}]} (the unit-text column is excluded).
   * Every variable picker (crosstab, model, subgroup, stratify) reads THIS,
   * never a hardcoded list.
   */
  columns: (p, c) => get_(`${P(p)}/corpora/${encodeURIComponent(c)}/columns`),
  /**
   * Re-unitize from a different column → {corpusId, unitCount, junk,
   * textColumn, skipped}. Builds a NEW corpus (the original is kept);
   * `skipped` counts source rows empty in the chosen column.
   */
  reunitize: (p, c, { textColumn } = {}) =>
    post(`${P(p)}/corpora/${encodeURIComponent(c)}/reunitize`, { textColumn }),
};

export const brief = {
  /** The persisted brief artifact (briefs/<bid>.json) — 404 when absent. */
  get: (p, bid) => get_(`${P(p)}/briefs/${encodeURIComponent(bid)}`),
  /**
   * Stream the Corpus Brief. POST + SSE (hence fetch-based, see header).
   * handlers: onParagraph({md, refs}) per streamed paragraph,
   *           onDone({briefId}), onError(ApiError). Returns {close}.
   */
  generate(p, corpusId, handlers = {}) {
    return sseSubscribe(`${P(p)}/brief`, {
      method: "POST",
      body: { corpusId },
      onEvent: (event, data) => {
        if (event === "para") handlers.onParagraph?.(data);
        else if (event === "done") handlers.onDone?.(data);
        else handlers.onEvent?.(event, data);
      },
      onDone: () => handlers.onClose?.(),
      onError: handlers.onError,
    });
  },
};

export const questionbar = {
  ask: (p, question) => post(`${P(p)}/questionbar`, { question }),
  approve: (p, planId) => post(`${P(p)}/questionbar/${encodeURIComponent(planId)}/approve`),
};

export const constructs = {
  list: (p) => get_(`${P(p)}/constructs`),
  create: (p, construct) => post(`${P(p)}/constructs`, construct),
  get: (p, id) => get_(`${P(p)}/constructs/${encodeURIComponent(id)}`),
  update: (p, id, construct) => put(`${P(p)}/constructs/${encodeURIComponent(id)}`, construct),
  remove: (p, id) => del(`${P(p)}/constructs/${encodeURIComponent(id)}`),
  /** Legacy codebook import (DOCX/PDF) → proposed Construct[]. */
  importFile(p, file) {
    const form = new FormData();
    form.append("file", file, file.name ?? "codebook");
    return request("POST", `${P(p)}/constructs/import`, { multipart: form });
  },
  /**
   * Formalize the USER's concepts (one per line, `name: optional hint`, or a
   * research question) against a corpus sample → {constructs: proposals[],
   * sampleN}. Proposals are un-persisted; accepting one goes through create().
   */
  draft: (p, { input, corpusId } = {}) => post(`${P(p)}/constructs/draft`, { input, corpusId }),
  inductive: (p, { corpusId, n } = {}) => post(`${P(p)}/constructs/inductive`, { corpusId, n }),
};

export const instruments = {
  list: (p) => get_(`${P(p)}/instruments`),
  create: (p, instrument) => post(`${P(p)}/instruments`, instrument),
  get: (p, id) => get_(`${P(p)}/instruments/${encodeURIComponent(id)}`),
  update: (p, id, instrument) => put(`${P(p)}/instruments/${encodeURIComponent(id)}`, instrument),
  remove: (p, id) => del(`${P(p)}/instruments/${encodeURIComponent(id)}`),
  compile: (p, i) => post(`${P(p)}/instruments/${encodeURIComponent(i)}/compile`),
  /**
   * Auto prompt-tuning against silver labels. POST + SSE. corpusId scopes the
   * sample (the server defaults to the project's first corpus otherwise).
   * handlers: onIteration({versionHash, agreement, note}), onDone({curve…}),
   * onError. Returns {close}.
   */
  silverTune(p, i, { n, corpusId } = {}, handlers = {}) {
    return sseSubscribe(`${P(p)}/instruments/${encodeURIComponent(i)}/silver-tune`, {
      method: "POST",
      body: { n, corpusId },
      onEvent: (event, data) => {
        if (event === "iteration") handlers.onIteration?.(data);
        else if (event === "done") handlers.onDone?.(data);
        else handlers.onEvent?.(event, data);
      },
      onDone: () => handlers.onClose?.(),
      onError: handlers.onError,
    });
  },
  stability: (p, i, { k, n, corpusId } = {}) => post(`${P(p)}/instruments/${encodeURIComponent(i)}/stability`, { k, n, corpusId }),
  freeze: (p, i, { goldsetId }) => post(`${P(p)}/instruments/${encodeURIComponent(i)}/freeze`, { goldsetId }),
  preview: (p, i, { unitIds, corpusId } = {}) => post(`${P(p)}/instruments/${encodeURIComponent(i)}/preview`, { unitIds, corpusId }),
};

export const goldsets = {
  list: (p) => get_(`${P(p)}/goldsets`),
  create: (p, goldset) => post(`${P(p)}/goldsets`, goldset),
  get: (p, id) => get_(`${P(p)}/goldsets/${encodeURIComponent(id)}`),
  update: (p, id, goldset) => put(`${P(p)}/goldsets/${encodeURIComponent(id)}`, goldset),
  remove: (p, id) => del(`${P(p)}/goldsets/${encodeURIComponent(id)}`),
  sample: (p, g, { design, n, strata } = {}) => post(`${P(p)}/goldsets/${encodeURIComponent(g)}/sample`, { design, n, strata }),
  /** Next unit for a blind coder. */
  next: (p, g, coder) => get_(`${P(p)}/goldsets/${encodeURIComponent(g)}/next`, { query: { coder } }),
  /** A blind verdict: {label} codes the unit; {uncodable: true} (no label) marks it can't-code. */
  label: (p, g, { coder, unitId, label, memo, flag, uncodable } = {}) =>
    post(`${P(p)}/goldsets/${encodeURIComponent(g)}/label`, { coder, unitId, label, memo, flag, uncodable }),
  agreement: (p, g) => get_(`${P(p)}/goldsets/${encodeURIComponent(g)}/agreement`),
  /** The final human word: {label} adopts a gold label; {exclude: true} drops the unit from gold permanently. */
  adjudicate: (p, g, { unitId, label, exclude } = {}) =>
    post(`${P(p)}/goldsets/${encodeURIComponent(g)}/adjudicate`, { unitId, label, exclude }),
  /** Route a unit to the human queue: joins the sample as {pi: null, queued: true}. Idempotent. */
  queue: (p, g, { unitId }) => post(`${P(p)}/goldsets/${encodeURIComponent(g)}/queue`, { unitId }),
  /** Start (or reuse) the same-process blind coder listener → {url, port, coderId}. */
  coderSession: (p, g, coderId) => post(`${P(p)}/goldsets/${encodeURIComponent(g)}/coder-session`, { coderId }),
  /** Close coder listeners for this gold set (one coder, or all when omitted) → {closed}. */
  endCoderSession: (p, g, coderId) =>
    request("DELETE", `${P(p)}/goldsets/${encodeURIComponent(g)}/coder-session`, { query: { coderId } }),
};

export const runs = {
  preflight: (p, { instrumentId, corpusId } = {}) => post(`${P(p)}/runs/preflight`, { instrumentId, corpusId }),
  start: (p, { instrumentId, corpusId, capUSD } = {}) => post(`${P(p)}/runs`, { instrumentId, corpusId, capUSD }),
  /** Rename a run (runs are auto-named "<instrument> · <corpus>" at creation). */
  rename: (p, r, name) => put(`${P(p)}/runs/${encodeURIComponent(r)}`, { name }),
  /**
   * Live run monitor. GET + SSE.
   * handlers: onTick({done,total,costUSD,labelDist,warnings}), onDone(data),
   * onError. Returns {close}.
   */
  monitor(p, r, handlers = {}) {
    return sseSubscribe(`${P(p)}/runs/${encodeURIComponent(r)}/monitor`, {
      onEvent: (event, data) => {
        if (event === "tick") handlers.onTick?.(data);
        else if (event === "done") handlers.onDone?.(data);
        else handlers.onEvent?.(event, data);
      },
      onDone: () => handlers.onClose?.(),
      onError: handlers.onError,
    });
  },
  pause: (p, r) => post(`${P(p)}/runs/${encodeURIComponent(r)}/pause`),
  resume: (p, r) => post(`${P(p)}/runs/${encodeURIComponent(r)}/resume`),
  abort: (p, r) => post(`${P(p)}/runs/${encodeURIComponent(r)}/abort`),
  escalations: (p, r) => get_(`${P(p)}/runs/${encodeURIComponent(r)}/escalations`),
  disagreement: (p, r) => get_(`${P(p)}/runs/${encodeURIComponent(r)}/disagreement`),
  /** Raw-stream labeled-data CSV (original columns + label/confidence/escalated);
      the server names the file, with -partial for incomplete runs. */
  exportCsvUrl: (p, r) => `${baseUrl}${P(p)}/runs/${encodeURIComponent(r)}/export.csv`,
  exportCsv(p, r) {
    const a = document.createElement("a");
    a.href = runs.exportCsvUrl(p, r);
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  },
};

export const analyses = {
  create: (p, { kind, spec }) => post(`${P(p)}/analyses`, { kind, spec }),
  /** The persisted analysis artifact (analyses/<id>.json) — 404 when absent. */
  get: (p, id) => get_(`${P(p)}/analyses/${encodeURIComponent(id)}`),
};

export const evidence = {
  /**
   * The dossier behind any number: {unit, dictionaryHits, outputs, goldLabels,
   * sourcePos}. Pass corpusId when the caller knows which corpus the number
   * came from (the coding sprint and adjudication know the gold set's corpus)
   * so the unit's TEXT resolves from that corpus — not whichever corpus is
   * listed first. Omitted, the server scans every corpus for the id.
   */
  get: (p, unitId, { corpusId } = {}) =>
    get_(`${P(p)}/evidence/${encodeURIComponent(unitId)}`, { query: { corpusId } }),
};

export const reliability = {
  /**
   * Every way one construct has been read, and how much the readers agree:
   * {constructId, corpusId, sources: [{key, label, kind: instrument|gold|
   * coder|retest, n, runId?, level?}], pairs: [{a, b, n, percent, kappa,
   * alpha}], notes: [string], retestAvailable?: false}. Backs the
   * Reliability home (#/p/:slug/reliability/:cid).
   */
  get: (p, constructId, { corpusId } = {}) =>
    get_(`${P(p)}/reliability/${encodeURIComponent(constructId)}`, { query: { corpusId } }),
};

export const report = {
  /**
   * The project report: {blocks: [{kind, ref?, content?, addedAt}], updatedAt}
   * persisted on the project. addBlock APPENDS one block (the Workbench's
   * "Add to report"); save REPLACES the block list (the canvas's reorder/
   * remove). Both resolve with the updated report, so callers can state the
   * real block count. The server's report export defaults to these blocks.
   */
  addBlock: (p, block) => post(`${P(p)}/report/blocks`, { block }),
  save: (p, blocks) => put(`${P(p)}/report`, { blocks }),
};

export const exports = {
  methods: (p) => get_(`${P(p)}/exports/methods`),
  /** Raw-stream endpoints (zip / standalone HTML) — link or download directly. */
  replicationUrl: (p) => `${baseUrl}${P(p)}/exports/replication`,
  reportUrl: (p) => `${baseUrl}${P(p)}/exports/report`,
  download(p, kind) {
    const url = kind === "report" ? exports.reportUrl(p) : exports.replicationUrl(p);
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  },
};

export const catalog = {
  models: () => get_("/api/catalog/models"),
};

export const settings = {
  get: () => get_("/api/settings"),
  update: (s) => put("/api/settings", s),
};

export const health = () => get_("/api/health");

export const api = {
  projects, imports, corpora, brief, questionbar, constructs, instruments,
  goldsets, runs, analyses, evidence, reliability, report, exports, catalog, settings, health,
};

export default api;
