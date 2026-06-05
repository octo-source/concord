// PII detection + reversible pseudonymization.
// scan(units) -> {findings: [{unitId, spans: [{kind, start, end, text}]}], counts}
// pseudonymize(units, vaultPath) -> {units: maskedUnits, vault: summary}
//   (vault JSON written to vaultPath — caller keeps it OUTSIDE project bundles)
// reidentify(units, vaultPath) -> restored units.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ConcordError } from "../core/errors.js";

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// URL with embedded credentials: scheme://user[:pass]@host/...
const URL_USER_RE = /\bhttps?:\/\/[^\s/@]+@[^\s"'<>]+/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// US formats (555-867-5309, (555) 867-5309, 555.867.5309) and international-ish
// (+44 20 7946 0958, +1-202-555-0143): an optional +CC then 7-12 digits with
// separators. Requires at least one separator or a leading + to avoid bare ids.
const PHONE_RE = /(?:\+\d{1,3}[-.\s]?)?(?:\(\d{2,4}\)[-.\s]?)?\d{2,4}(?:[-.\s]\d{2,4}){2,4}|\+\d{8,14}\b/g;

// Capitalized-bigram name heuristic stoplist: common capitalized words that
// start places, orgs, months, weekdays, honorific phrases.
const NAME_STOP = new Set([
  "United", "States", "New", "York", "Los", "Angeles", "San", "Las", "North",
  "South", "East", "West", "Great", "Britain", "Hong", "Kong", "Saudi",
  "Arabia", "Sri", "Lanka", "Costa", "Rica", "Puerto", "Rico", "Latin",
  "America", "Middle", "Eastern", "Western", "Northern", "Southern",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
  "Many", "Thanks", "Thank", "Best", "Kind", "Regards", "Dear", "Happy",
  "Human", "Resources", "Customer", "Service", "Vice", "President", "General",
  "Manager", "Senior", "Junior", "Chief", "Executive", "Officer", "Account",
  "The", "This", "That", "These", "Those", "There", "Then", "When", "Where",
  "What", "Which", "While", "After", "Before", "During", "Every", "Some",
  "All", "Most", "More", "Less", "Very", "Much", "Such", "Other", "Another",
  "First", "Second", "Third", "Last", "Next", "Per", "Pro", "Anti",
  "God", "Lord", "Christmas", "Easter", "Thanksgiving", "Internet", "Google",
  "Microsoft", "Apple", "Amazon", "Facebook", "Twitter", "Zoom", "Excel",
  "Word", "Slack", "Teams", "Covid", "American", "British", "European",
  "English", "Spanish", "French", "German", "Chinese", "Japanese",
]);

const BIGRAM_RE = /\b([A-Z][a-z]+)[ \t]+([A-Z][a-z]+)\b/g;

function atSentenceStart(text, idx) {
  // Walk back over whitespace; sentence start = string start, or after
  // terminal punctuation, or after an opening quote at one of those.
  let i = idx - 1;
  while (i >= 0 && /[\s"'(\[]/.test(text[i])) i--;
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

export function scan(units) {
  const findings = [];
  const counts = { email: 0, phone: 0, ssn: 0, url_user: 0, name: 0 };
  for (const u of units) {
    const spans = scanText(u.text);
    if (spans.length === 0) continue;
    findings.push({ unitId: u.id, spans });
    const kinds = [...new Set(spans.map((s) => s.kind))];
    u.flags = u.flags || {};
    u.flags.pii = kinds;
    for (const s of spans) counts[s.kind]++;
  }
  return { findings, counts };
}

const KIND_TOKEN = { email: "EMAIL", phone: "PHONE", ssn: "SSN", url_user: "URL", name: "NAME" };

async function writeJsonAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await rename(tmp, path);
}

// Replace every PII span with a stable token ([EMAIL_1], [NAME_2], ...) —
// the same original string always maps to the same token. Returns new unit
// objects (ids preserved); writes the reversible map to vaultPath.
export async function pseudonymize(units, vaultPath) {
  if (!vaultPath) throw new ConcordError("NO_VAULT_PATH", "pseudonymize requires a vault path outside the project bundle", {});
  const tokenOf = new Map(); // `${kind}|${original}` -> token
  const tokens = {}; // token -> original
  const counters = {};
  const counts = { email: 0, phone: 0, ssn: 0, url_user: 0, name: 0 };
  const masked = units.map((u) => {
    const spans = scanText(u.text);
    if (spans.length === 0) return { ...u };
    // Assign tokens in reading order so numbering follows first occurrence...
    for (const span of spans) {
      const key = `${span.kind}|${span.text}`;
      if (!tokenOf.has(key)) {
        const label = KIND_TOKEN[span.kind];
        counters[label] = (counters[label] || 0) + 1;
        const token = `[${label}_${counters[label]}]`;
        tokenOf.set(key, token);
        tokens[token] = span.text;
      }
    }
    // ...then replace right-to-left so earlier offsets stay valid.
    let text = u.text;
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      const token = tokenOf.get(`${span.kind}|${span.text}`);
      text = text.slice(0, span.start) + token + text.slice(span.end);
      counts[span.kind]++;
    }
    const flags = { ...(u.flags || {}), pii: [...new Set(spans.map((s) => s.kind))] };
    return { ...u, text, flags };
  });
  const vault = {
    version: 1,
    createdAt: new Date().toISOString(),
    tokens,
    counts,
  };
  await writeJsonAtomic(vaultPath, vault);
  return { units: masked, vault: { path: vaultPath, counts, tokenCount: Object.keys(tokens).length } };
}

const TOKEN_RE = /\[(EMAIL|PHONE|SSN|URL|NAME)_\d+\]/g;

// Restore original text from the vault map. Returns new unit objects.
export async function reidentify(units, vaultPath) {
  let vault;
  try {
    vault = JSON.parse(await readFile(vaultPath, "utf8"));
  } catch (e) {
    throw new ConcordError("BAD_VAULT", `cannot read vault at ${vaultPath}: ${e.message}`, { vaultPath });
  }
  if (!vault || typeof vault.tokens !== "object") {
    throw new ConcordError("BAD_VAULT", "vault file has no tokens map", { vaultPath });
  }
  return units.map((u) => {
    const text = u.text.replace(TOKEN_RE, (tok) => vault.tokens[tok] ?? tok);
    return { ...u, text };
  });
}
