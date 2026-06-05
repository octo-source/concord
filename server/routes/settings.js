// Settings: provider keys (masked on GET, written to config/keys.json with
// the adapter cache cleared), the app port, and per-project settings —
// privacy mode (changes ledgered; LOOSENING the mode requires an explicit
// {confirmDowngrade: true}), budget cap, and the Director slot (including
// systemSuffix).
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ConcordError } from "../core/errors.js";
import { updateProject, loadProject } from "../core/store.js";
import * as ledger from "../core/ledger.js";
import { clearAdapterCache } from "../providers/registry.js";
import { PRIVACY_MODES } from "../core/objects.js";
import { pdirOf, configDir, keysFile, readKeysFile, readJsonFile } from "./_shared.js";

// strictness rank: moving DOWN (strict → no-training → open) is a downgrade
const RANK = { open: 0, "no-training": 1, strict: 2 };

function mask(key) {
  const s = String(key);
  if (s.length <= 7) return "…";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function maskedKeys(keys) {
  const out = {};
  for (const [provider, entry] of Object.entries(keys ?? {})) {
    if (typeof entry === "string") {
      out[provider] = { configured: true, apiKey: mask(entry) };
    } else if (entry && typeof entry === "object") {
      out[provider] = {
        configured: Boolean(entry.apiKey),
        ...(entry.apiKey ? { apiKey: mask(entry.apiKey) } : {}),
        ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      };
    }
  }
  return out;
}

async function currentSettings() {
  const keys = await readKeysFile();
  const app = (await readJsonFile(path.join(configDir(), "app.json"))) ?? {};
  return { keys: maskedKeys(keys), port: app.port ?? 7341 };
}

async function applyProjectSettings(body) {
  const { slug } = body;
  if (!slug) throw new ConcordError("VALIDATION", "project settings require a slug", {});
  const before = await loadProject(slug);
  let modeChange = null;

  if (body.privacyMode !== undefined && body.privacyMode !== before.privacyMode) {
    if (!PRIVACY_MODES.includes(body.privacyMode)) {
      throw new ConcordError("VALIDATION", `privacyMode must be one of ${PRIVACY_MODES.join(", ")}`, { privacyMode: body.privacyMode });
    }
    const downgrade = RANK[body.privacyMode] < RANK[before.privacyMode];
    if (downgrade && body.confirmDowngrade !== true) {
      throw new ConcordError("VALIDATION",
        `changing privacy mode from "${before.privacyMode}" to "${body.privacyMode}" weakens this project's privacy guarantees — repeat the request with {confirmDowngrade: true} to proceed`,
        { from: before.privacyMode, to: body.privacyMode });
    }
    modeChange = { from: before.privacyMode, to: body.privacyMode, downgrade };
  }

  let director;
  if (body.director !== undefined) {
    if (body.director === null) {
      director = null;
    } else {
      const d = body.director;
      if (!d.provider || !d.model) {
        throw new ConcordError("VALIDATION", "director requires {provider, model}", {});
      }
      director = {
        provider: d.provider,
        model: d.model,
        snapshot: d.snapshot ?? null,
        ...(typeof d.systemSuffix === "string" && d.systemSuffix !== "" ? { systemSuffix: d.systemSuffix } : {}),
      };
    }
  }

  const updated = await updateProject(slug, (p) => {
    if (modeChange) p.privacyMode = modeChange.to;
    if (body.budget !== undefined) {
      const cap = body.budget.capUSD;
      if (cap !== null && cap !== undefined && (typeof cap !== "number" || cap < 0)) {
        throw new ConcordError("VALIDATION", "budget.capUSD must be null or a number >= 0", { capUSD: cap });
      }
      p.budget = p.budget ?? { capUSD: null, spentUSD: 0 };
      if (cap !== undefined) p.budget.capUSD = cap;
    }
    if (director !== undefined) p.director = director;
  });

  if (modeChange) {
    await ledger.append(pdirOf(slug), "human", "privacy.mode_changed", { projectId: updated.id }, modeChange);
  }
  return updated;
}

export default [
  {
    method: "GET",
    pattern: "/api/settings",
    handler: async () => currentSettings(),
  },
  {
    method: "PUT",
    pattern: "/api/settings",
    handler: async (req) => {
      const body = req.body ?? {};
      const result = {};

      if (body.keys !== undefined) {
        if (typeof body.keys !== "object" || body.keys === null) {
          throw new ConcordError("VALIDATION", "keys must be an object of provider → key", {});
        }
        const existing = await readKeysFile();
        for (const [provider, entry] of Object.entries(body.keys)) {
          if (entry === null || entry === "") delete existing[provider];
          else existing[provider] = entry;
        }
        await mkdir(configDir(), { recursive: true });
        await writeFile(keysFile(), JSON.stringify(existing, null, 2), "utf8");
        // rotated keys are invisible to the adapter cache key — drop it
        clearAdapterCache();
        result.keysUpdated = Object.keys(body.keys);
      }

      if (body.port !== undefined) {
        if (!Number.isInteger(body.port) || body.port < 0 || body.port > 65535) {
          throw new ConcordError("VALIDATION", "port must be an integer 0–65535", { port: body.port });
        }
        const app = (await readJsonFile(path.join(configDir(), "app.json"))) ?? {};
        app.port = body.port;
        await mkdir(configDir(), { recursive: true });
        await writeFile(path.join(configDir(), "app.json"), JSON.stringify(app, null, 2), "utf8");
        result.port = body.port;
      }

      if (body.project !== undefined) {
        result.project = await applyProjectSettings({ ...body.project, confirmDowngrade: body.confirmDowngrade ?? body.project.confirmDowngrade });
      }

      return { ...(await currentSettings()), ...result };
    },
  },
];
