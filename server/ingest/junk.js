// Junk scanner. Advisory flags only — nothing is dropped; the review queue
// shows flagged units. scan(units) mutates units (sets flags.junk and, for
// dups, flags.dup = original unit id) and returns {flagged, counts}.
// Precedence per unit: na > bot > dup > short.

const NA_SET = new Set([
  "na", "n/a", "n.a.", "n.a", "none", "nothing", "null", "nil", "no", "-", "--",
  "—", ".", "..", "...", "x", "xx", "xxx", "idk", "n/a.", "nope",
]);

const KEY_ROWS = [/^[qwertyuiop]+$/, /^[asdfghjkl;']+$/, /^[zxcvbnm,.]+$/];

// "asdf-like keyboard mash": every token is >=3 chars drawn from one keyboard row.
export function isKeyboardMash(text) {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((tok) => tok.length >= 3 && KEY_ROWS.some((re) => re.test(tok)));
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
