// Junk scanner. Advisory flags only — nothing is dropped; the review queue
// shows flagged units. scan(units) mutates units (sets flags.junk and, for
// dups, flags.dup = original unit id) and returns {flagged, counts}.
// Precedence per unit: na > bot > dup > short.

// NOTE: bare "no" / "nope" are deliberately NOT here — they are substantive
// answers to yes/no survey questions, not non-answers.
const NA_SET = new Set([
  "na", "n/a", "n.a.", "n.a", "none", "nothing", "null", "nil", "-", "--",
  "—", ".", "..", "...", "x", "xx", "xxx", "idk", "n/a.",
]);

// Keyboard mash = a token that is a contiguous run along one keyboard row
// ("asdf", "qwerty", "poiuy" — forward or reversed), or a short chunk repeated
// to fill the whole token ("asdfasdf", "xxxx"). Mere set-membership over row
// letters is NOT enough: real words like "true", "power", "sad", "salad" are
// spelled entirely from row letters and must not be flagged.
const ROW_SEQS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const ROW_RUNS = [...ROW_SEQS, ...ROW_SEQS.map((r) => [...r].reverse().join(""))];

function isRowRun(tok) {
  return tok.length >= 3 && ROW_RUNS.some((row) => row.includes(tok));
}

function isRepeatedChunk(tok) {
  if (tok.length < 3) return false;
  for (let len = 1; len <= 4 && len * 2 <= tok.length; len++) {
    if (tok.length % len !== 0) continue;
    if (tok.slice(0, len).repeat(tok.length / len) === tok) return true;
  }
  return false;
}

export function isKeyboardMash(text) {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((tok) => isRowRun(tok) || isRepeatedChunk(tok));
}

export function isNa(text) {
  const t = text.trim().toLowerCase();
  if (t.length === 0) return true;
  if (NA_SET.has(t)) return true;
  if (NA_SET.has(t.replace(/[.!]+$/, ""))) return true; // "none.", "nothing!"
  return isKeyboardMash(t);
}

function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenCount(text) {
  let n = 0;
  let inTok = false;
  for (let i = 0; i < text.length; i++) {
    const ws = text.charCodeAt(i) <= 32;
    if (!ws && !inTok) {
      n++;
      inTok = true;
    } else if (ws) inTok = false;
  }
  return n;
}

function median(nums) {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function scan(units) {
  const flagged = [];
  const counts = { na: 0, short: 0, dup: 0, bot: 0 };

  const toks = units.map((u) => tokenCount(u.text));
  const med = median(toks);
  const shortApplies = med >= 3; // skip "short" when the whole corpus is short

  // Pass 1: group by normalized text for dup/bot.
  const groups = new Map(); // norm -> {firstId, ids: [unitId], tokens}
  const norms = new Array(units.length);
  for (let i = 0; i < units.length; i++) {
    const norm = normalize(units[i].text);
    norms[i] = norm;
    let g = groups.get(norm);
    if (!g) {
      g = { firstId: units[i].id, ids: [], tokens: toks[i] };
      groups.set(norm, g);
    }
    g.ids.push(units[i].id);
  }

  const flag = (unit, kind, of) => {
    unit.flags = unit.flags || {};
    unit.flags.junk = kind;
    if (kind === "dup" && of) unit.flags.dup = of;
    const entry = { unitId: unit.id, kind };
    if (of) entry.of = of;
    flagged.push(entry);
    counts[kind]++;
  };

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const g = groups.get(norms[i]);
    const isBotGroup = g.ids.length >= 3 && g.tokens >= 6 && !isNa(u.text);
    if (isNa(u.text)) {
      flag(u, "na");
    } else if (isBotGroup) {
      flag(u, "bot", g.firstId === u.id ? undefined : g.firstId);
    } else if (g.firstId !== u.id) {
      flag(u, "dup", g.firstId);
    } else if (shortApplies && toks[i] < 3) {
      flag(u, "short");
    }
  }

  return { flagged, counts };
}
