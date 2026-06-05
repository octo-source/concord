// The ONLY sanctioned constructor path for adapters. Privacy modes are
// enforced here — before any key is read and before any object that could
// touch the network exists. Overrides return a ledgerEvent for the CALLER to
// append; this module never writes the ledger itself.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConcordError } from "../core/errors.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { OpenRouterAdapter } from "./openrouter.js";
import { OllamaAdapter } from "./ollama.js";
import { MockAdapter } from "./mock.js";

// Module-private on purpose: exporting raw constructors would let callers
// bypass the privacy gates below. getAdapter() is the only way out.
const PROVIDERS = Object.freeze({
  anthropic: AnthropicAdapter,
  openai: OpenAIAdapter,
  openrouter: OpenRouterAdapter,
  ollama: OllamaAdapter,
  mock: MockAdapter,
});

const LOCAL = new Set(["mock", "ollama"]);
const NO_TRAINING_ALLOW = new Set(["anthropic", "openai"]);
const MODES = new Set(["open", "no-training", "strict"]);

// getAdapter(project, providerName, {justification?, keysPath?})
// → {adapter, ledgerEvent: null | {actor, type, refs, payload}}
export function getAdapter(project, providerName, { justification, keysPath } = {}) {
  const Ctor = PROVIDERS[providerName];
  if (!Ctor) {
    throw new ConcordError("CONFIG_MISSING", `unknown provider "${providerName}"`, {
      provider: providerName, known: Object.keys(PROVIDERS),
    });
  }

  const mode = project?.privacyMode;
  if (mode === undefined || mode === null) {
    // Fail closed: a caller that omits the privacy mode gets no adapter, not
    // the most permissive one. Stored projects always carry a validated mode
    // (objects.js defaults to "open" at creation), so only malformed callers
    // land here.
    throw new ConcordError("PRIVACY_BLOCKED", "privacy mode missing from project; refusing to construct an adapter", {
      mode: null, provider: providerName,
    });
  }
  if (!MODES.has(mode)) {
    // Fail closed: an unrecognized mode is config corruption, not permission.
    throw new ConcordError("PRIVACY_BLOCKED", `unknown privacy mode "${mode}"`, { mode, provider: providerName });
  }

  let ledgerEvent = null;
  if (mode === "strict" && !LOCAL.has(providerName)) {
    throw new ConcordError(
      "PRIVACY_BLOCKED",
      `privacy mode "strict" permits only local backends (mock, ollama); "${providerName}" sends data off-machine`,
      { mode, provider: providerName },
    );
  }
  if (mode === "no-training" && !LOCAL.has(providerName) && !NO_TRAINING_ALLOW.has(providerName)) {
    if (typeof justification !== "string" || justification.trim() === "") {
      throw new ConcordError(
        "PRIVACY_BLOCKED",
        `privacy mode "no-training" blocks "${providerName}"; pass a written justification to override (it will be ledgered)`,
        { mode, provider: providerName },
      );
    }
    ledgerEvent = {
      actor: "human",
      type: "privacy.override",
      refs: { provider: providerName },
      payload: { justification },
    };
  }

  const keys = readKeys(keysPath ?? resolve(process.cwd(), "config", "keys.json"));
  return { adapter: new Ctor(normalizeEntry(keys[providerName])), ledgerEvent };
}

// keys.json may be absent (→ keyless adapter: complete() throws
// CONFIG_MISSING, catalog() still serves the static fallback). A present but
// malformed file is loud, never silently ignored.
function readKeys(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new ConcordError("CONFIG_MISSING", `cannot read ${path}: ${err.message}`, { path });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConcordError("CONFIG_MISSING", `keys file is not valid JSON: ${err.message}`, { path });
  }
}

// Entries may be a bare key string or {apiKey, baseUrl}.
function normalizeEntry(entry) {
  if (!entry) return {};
  if (typeof entry === "string") return { apiKey: entry };
  return { apiKey: entry.apiKey, baseUrl: entry.baseUrl };
}
