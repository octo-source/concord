// PII detection + reversible pseudonymization.
// scan(units) -> {findings: [{unitId, spans, meta?: [{column, spans}]}], counts}
//   (spans: [{kind, start, end, text}])
// pseudonymize(units, vaultPath) -> {units: maskedUnits, vault: summary}
//   (vault JSON written to vaultPath — caller keeps it OUTSIDE project bundles)
// reidentify(units, vaultPath) -> restored units.
//
// Identifiers do not only live in unit text: survey exports carry contact
// emails/phones in METADATA columns, and meta values ride into the
// replication archive's units CSV and into Director prompts (renderUnit).
// So every STRING metadata value is scanned and masked exactly like unit
// text — same counts, same vault, same [KIND_n] tokens. Non-string values
// (numbers, nulls) pass through untouched: the regexes cannot match a bare
// number, and masking must never change a value's type.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { renameWithRetry } from "../core/store.js";
import { dirname } from "node:path";
import { ConcordError } from "../core/errors.js";

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// URL with embedded credentials: scheme://user[:pass]@host/...
const URL_USER_RE = /\bhttps?:\/\/[^\s/@]+@[^\s"'<>]+/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// US formats (555-867-5309, (555) 867-5309, 555.867.5309) and international-ish
// (+44 20 7946 0958, +1-202-555-0143): an optional +CC then 7-12 digits with
// separators. Requires at least one separator or a leading + to avoid bare ids.
// Three branches: parenthesized area code (needs only one more separator,
// "(555) 867-5309"), plain separated runs (need two, so "12-34" stays out),
// and bare +international.
const PHONE_RE =
  /(?:\+\d{1,3}[-.\s]?)?\(\d{2,4}\)[-.\s]?\d{2,4}(?:[-.\s]\d{2,4}){1,4}|(?:\+\d{1,3}[-.\s]?)?\d{2,4}(?:[-.\s]\d{2,4}){2,4}|\+\d{8,14}\b/g;

// Capitalized-bigram name heuristic stoplist: common capitalized words that
// start places, orgs, months, weekdays, honorific phrases.
const NAME_STOP = new Set([
  "United",
  "States",
  "New",
  "York",
  "Los",
  "Angeles",
  "San",
  "Las",
  "North",
  "South",
  "East",
  "West",
  "Great",
  "Britain",
  "Hong",
  "Kong",
  "Saudi",
  "Arabia",
  "Sri",
  "Lanka",
  "Costa",
  "Rica",
  "Puerto",
  "Rico",
  "Latin",
  "America",
  "Middle",
  "Eastern",
  "Western",
  "Northern",
  "Southern",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "Many",
  "Thanks",
  "Thank",
  "Best",
  "Kind",
  "Regards",
  "Dear",
  "Happy",
  "Human",
  "Resources",
  "Customer",
  "Service",
  "Vice",
  "President",
  "General",
  "Manager",
  "Senior",
  "Junior",
  "Chief",
  "Executive",
  "Officer",
  "Account",
  "The",
  "This",
  "That",
  "These",
  "Those",
  "There",
  "Then",
  "When",
  "Where",
  "What",
  "Which",
  "While",
  "After",
  "Before",
  "During",
  "Every",
  "Some",
  "All",
  "Most",
  "More",
  "Less",
  "Very",
  "Much",
  "Such",
  "Other",
  "Another",
  "First",
  "Second",
  "Third",
  "Last",
  "Next",
  "Per",
  "Pro",
  "Anti",
  "God",
  "Lord",
  "Christmas",
  "Easter",
  "Thanksgiving",
  "Internet",
  "Google",
  "Microsoft",
  "Apple",
  "Amazon",
  "Facebook",
  "Twitter",
  "Zoom",
  "Excel",
  "Word",
  "Slack",
  "Teams",
  "Covid",
  "American",
  "British",
  "European",
  "English",
  "Spanish",
  "French",
  "German",
  "Chinese",
  "Japanese",
]);

// Unicode-aware capitalized bigram: \p{Lu}\p{L}+ matches "José García",
// "Łukasz Kowalski", Cyrillic names, ... — the old ASCII [A-Z][a-z]+ class
// produced zero spans for accented names. Sentence-start suppression and the
// stoplist below still apply.
const BIGRAM_RE = /\b(\p{Lu}\p{L}+)[ \t]+(\p{Lu}\p{L}+)\b/gu;

function atSentenceStart(text, idx) {
  // Walk back over whitespace; sentence start = string start, or after
  // terminal punctuation, or after an opening quote at one of those.
  let i = idx - 1;
  while (i >= 0 && /[\s"'([]/.test(text[i])) i--;
  if (i < 0) return true;
  return /[.!?:;\n]/.test(text[i]);
}

function findNames(text) {
  const spans = [];
  BIGRAM_RE.lastIndex = 0;
  let m;
  while ((m = BIGRAM_RE.exec(text))) {
    const [whole, w1, w2] = m;
    if (NAME_STOP.has(w1) || NAME_STOP.has(w2)) continue;
    if (atSentenceStart(text, m.index)) continue;
    spans.push({ kind: "name", start: m.index, end: m.index + whole.length, text: whole });
  }
  return spans;
}

function findRegex(text, re, kind, validate) {
  const spans = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const s = m[0];
    if (validate && !validate(s)) continue;
    spans.push({ kind, start: m.index, end: m.index + s.length, text: s });
    if (m.index === re.lastIndex) re.lastIndex++; // safety vs zero-width
  }
  return spans;
}

function validPhone(s) {
  const t = s.trim();
  // Date shapes are not phones: ISO "2024-01-15", EU/US "10.04.2022" /
  // "1-15-2024", and bare year-list runs like "2022 2023 2024".
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(t)) return false;
  if (/^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(t)) return false;
  if (/^\d{4}(?:\s\d{4})+$/.test(t)) return false;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

// Resolve overlaps: longer span wins (a URL with credentials beats the email
// embedded in it); ties broken by kind priority.
const PRIORITY = ["url_user", "email", "ssn", "phone", "name"];

function beats(a, b) {
  const la = a.end - a.start;
  const lb = b.end - b.start;
  if (la !== lb) return la > lb;
  return PRIORITY.indexOf(a.kind) < PRIORITY.indexOf(b.kind);
}

export function scanText(text) {
  const all = [
    ...findRegex(text, URL_USER_RE, "url_user"),
    ...findRegex(text, EMAIL_RE, "email"),
    ...findRegex(text, SSN_RE, "ssn"),
    ...findRegex(text, PHONE_RE, "phone", validPhone),
    ...findNames(text),
  ];
  all.sort((a, b) => a.start - b.start || PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  const kept = [];
  for (const span of all) {
    const clash = kept.find((k) => span.start < k.end && k.start < span.end);
    if (!clash) kept.push(span);
    else if (beats(span, clash)) kept[kept.indexOf(clash)] = span;
  }
  return kept.sort((a, b) => a.start - b.start);
}

// String metadata values of a unit, in column order — the fields beyond
// u.text that scan/pseudonymize/reidentify must cover.
function stringMetaEntries(u) {
  return Object.entries(u.meta ?? {}).filter(([, v]) => typeof v === "string" && v !== "");
}

export function scan(units) {
  const findings = [];
  const counts = { email: 0, phone: 0, ssn: 0, url_user: 0, name: 0 };
  for (const u of units) {
    const spans = scanText(u.text);
    const metaFindings = [];
    for (const [column, v] of stringMetaEntries(u)) {
      const ms = scanText(v);
      if (ms.length) metaFindings.push({ column, spans: ms });
    }
    if (spans.length === 0 && metaFindings.length === 0) continue;
    findings.push({ unitId: u.id, spans, ...(metaFindings.length ? { meta: metaFindings } : {}) });
    const all = [...spans, ...metaFindings.flatMap((f) => f.spans)];
    u.flags = u.flags || {};
    u.flags.pii = [...new Set(all.map((s) => s.kind))];
    for (const s of all) counts[s.kind]++;
  }
  return { findings, counts };
}

const KIND_TOKEN = { email: "EMAIL", phone: "PHONE", ssn: "SSN", url_user: "URL", name: "NAME" };

async function writeJsonAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await renameWithRetry(tmp, path);
}

const TOKEN_RE = /\[(EMAIL|PHONE|SSN|URL|NAME)_\d+\]/g;
const TOKEN_PARSE = /^\[([A-Z]+)_(\d+)\]$/;
const LABEL_KIND = Object.fromEntries(Object.entries(KIND_TOKEN).map(([k, v]) => [v, k]));

// Load an existing vault for accumulation. Missing file -> null (fresh vault);
// unreadable/garbled file -> BAD_VAULT (never silently start over and lose the
// existing token map).
async function loadVault(vaultPath) {
  let raw;
  try {
    raw = await readFile(vaultPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new ConcordError("BAD_VAULT", `cannot read vault at ${vaultPath}: ${e.message}`, {
      vaultPath,
    });
  }
  let vault;
  try {
    vault = JSON.parse(raw);
  } catch (e) {
    throw new ConcordError("BAD_VAULT", `vault at ${vaultPath} is not valid JSON: ${e.message}`, {
      vaultPath,
    });
  }
  if (!vault || typeof vault.tokens !== "object" || vault.tokens === null) {
    throw new ConcordError("BAD_VAULT", "vault file has no tokens map", { vaultPath });
  }
  return vault;
}

// Replace every PII span with a stable token ([EMAIL_1], [NAME_2], ...) —
// the same original string always maps to the same token. Returns new unit
// objects (ids preserved); writes the reversible map to vaultPath.
//
// The vault ACCUMULATES: if vaultPath already exists it is loaded, token
// numbering continues from the highest existing index per kind, and the new
// mappings are unioned in — a second batch can never reuse [EMAIL_1] for a
// different address, and re-running over already-masked text is a no-op
// (vault-known [KIND_n] tokens in the input are left untouched). A token-
// shaped string that the vault does NOT know means the text was masked
// against some other vault; remapping it would corrupt re-identification, so
// that throws VAULT_CONFLICT and leaves the vault file unmodified.
export async function pseudonymize(units, vaultPath) {
  if (!vaultPath)
    throw new ConcordError(
      "NO_VAULT_PATH",
      "pseudonymize requires a vault path outside the project bundle",
      {},
    );
  const existing = await loadVault(vaultPath);
  const tokens = { ...(existing?.tokens || {}) }; // token -> original (union)
  const tokenOf = new Map(); // `${kind}|${original}` -> token
  const counters = {}; // label -> highest index in use
  for (const [token, original] of Object.entries(tokens)) {
    const m = TOKEN_PARSE.exec(token);
    if (!m) continue;
    const kind = LABEL_KIND[m[1]];
    if (kind && !tokenOf.has(`${kind}|${original}`)) tokenOf.set(`${kind}|${original}`, token);
    counters[m[1]] = Math.max(counters[m[1]] || 0, parseInt(m[2], 10));
  }
  const counts = { email: 0, phone: 0, ssn: 0, url_user: 0, name: 0 };

  // Mask ONE string field (the unit text or one metadata value) against the
  // shared token state. `where` rides into error details ({unitId, column?}).
  const maskField = (text, where) => {
    // Token-shaped spans already in the field: vault-known -> protected no-op
    // (idempotent re-run); unknown -> refuse (see VAULT_CONFLICT above).
    const protectedRanges = [];
    TOKEN_RE.lastIndex = 0;
    let tm;
    while ((tm = TOKEN_RE.exec(text))) {
      if (Object.prototype.hasOwnProperty.call(tokens, tm[0])) {
        protectedRanges.push([tm.index, tm.index + tm[0].length]);
      } else {
        throw new ConcordError(
          "VAULT_CONFLICT",
          `text contains pseudonym token ${tm[0]} that is not in the vault; refusing to remap an existing token to a different original`,
          { vaultPath, token: tm[0], ...where },
        );
      }
    }
    let spans = scanText(text);
    if (protectedRanges.length) {
      spans = spans.filter((s) => !protectedRanges.some(([a, b]) => s.start < b && a < s.end));
    }
    if (spans.length === 0) return { text, kinds: [] };
    // Assign tokens in reading order so numbering follows first occurrence...
    for (const span of spans) {
      const key = `${span.kind}|${span.text}`;
      if (!tokenOf.has(key)) {
        const label = KIND_TOKEN[span.kind];
        counters[label] = (counters[label] || 0) + 1;
        const token = `[${label}_${counters[label]}]`;
        if (Object.prototype.hasOwnProperty.call(tokens, token) && tokens[token] !== span.text) {
          // invariant guard: counters continue past every vault index, so a
          // collision here means the vault was edited out from under us
          throw new ConcordError(
            "VAULT_CONFLICT",
            `token ${token} already maps to a different original`,
            { vaultPath, token },
          );
        }
        tokenOf.set(key, token);
        tokens[token] = span.text;
      }
    }
    // ...then replace right-to-left so earlier offsets stay valid.
    let out = text;
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      const token = tokenOf.get(`${span.kind}|${span.text}`);
      out = out.slice(0, span.start) + token + out.slice(span.end);
      counts[span.kind]++;
    }
    return { text: out, kinds: spans.map((s) => s.kind) };
  };

  const masked = units.map((u) => {
    // unit text first, then metadata values in column order, so token
    // numbering follows reading order within the unit
    const t = maskField(u.text, { unitId: u.id });
    const kinds = new Set(t.kinds);
    let meta = u.meta; // copied on first change; untouched meta keeps its ref
    for (const [column, v] of stringMetaEntries(u)) {
      const f = maskField(v, { unitId: u.id, column });
      for (const k of f.kinds) kinds.add(k);
      if (f.text !== v) {
        if (meta === u.meta) meta = { ...u.meta };
        meta[column] = f.text;
      }
    }
    if (kinds.size === 0) return { ...u };
    const flags = { ...(u.flags || {}), pii: [...kinds] };
    return { ...u, text: t.text, ...(meta !== u.meta ? { meta } : {}), flags };
  });
  // Cumulative occurrence counts across every batch written to this vault.
  const vaultCounts = { ...counts };
  for (const [k, v] of Object.entries(existing?.counts || {})) {
    vaultCounts[k] = (vaultCounts[k] || 0) + v;
  }
  const vault = {
    version: 1,
    createdAt: existing?.createdAt || new Date().toISOString(),
    tokens,
    counts: vaultCounts,
  };
  await writeJsonAtomic(vaultPath, vault);
  return {
    units: masked,
    vault: { path: vaultPath, counts, tokenCount: Object.keys(tokens).length },
  };
}

// Restore original text AND metadata values from the vault map. Returns new
// unit objects.
export async function reidentify(units, vaultPath) {
  let vault;
  try {
    vault = JSON.parse(await readFile(vaultPath, "utf8"));
  } catch (e) {
    throw new ConcordError("BAD_VAULT", `cannot read vault at ${vaultPath}: ${e.message}`, {
      vaultPath,
    });
  }
  if (!vault || typeof vault.tokens !== "object") {
    throw new ConcordError("BAD_VAULT", "vault file has no tokens map", { vaultPath });
  }
  const restore = (s) => s.replace(TOKEN_RE, (tok) => vault.tokens[tok] ?? tok);
  return units.map((u) => {
    const text = restore(u.text);
    let meta = u.meta; // copied on first change, like pseudonymize
    for (const [column, v] of stringMetaEntries(u)) {
      const r = restore(v);
      if (r !== v) {
        if (meta === u.meta) meta = { ...u.meta };
        meta[column] = r;
      }
    }
    return { ...u, text, ...(meta !== u.meta ? { meta } : {}) };
  });
}
