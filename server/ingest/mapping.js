// Column role detection over parsed tabular rows.
// Roles: text | categorical | numeric | date | id | ignore.
// Heuristics (per implementation plan):
//   text  = mean length > 40 chars OR (>20 distinct values AND mean length > 25)
//   numeric = >90% of non-missing values parse as numbers
//   date  = >80% parse as dates (ISO, US, EU)
//   id    = unique short token-like values (or unique + id-ish column name)
//   else categorical; all-missing columns -> ignore

const NUM_RE = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/;

export function looksNumeric(s) {
  return NUM_RE.test(s.trim());
}

const ISO_RE = /^\d{4}-\d{1,2}-\d{1,2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const US_EU_SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const EU_DOT_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/;
const MON_RE = /^\d{1,2}[- ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[- .,]+\d{2,4}$/i;
const MONTH_FIRST_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[ .]+\d{1,2},?\s+\d{2,4}$/i;

export function looksDate(s) {
  const t = s.trim();
  if (ISO_RE.test(t)) {
    const [y, m, d] = t.slice(0, 10).split("-").map(Number);
    return y >= 1000 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  }
  let m = US_EU_SLASH_RE.exec(t) || EU_DOT_RE.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    // valid if readable as US (m/d) or EU (d/m)
    const us = a >= 1 && a <= 12 && b >= 1 && b <= 31;
    const eu = b >= 1 && b <= 12 && a >= 1 && a <= 31;
    return us || eu;
  }
  return MON_RE.test(t) || MONTH_FIRST_RE.test(t);
}

const MISSING = new Set(["", "na", "n/a", "null", "nan", "-"]);

function isMissing(v) {
  if (v === null || v === undefined) return true;
  return MISSING.has(String(v).trim().toLowerCase());
}

const ID_NAME_RE = /(^|_)(id|uuid|guid|key|respondent|participant)$|^(id|uuid|guid)/i;

export function detect(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { columns: [] };
  // Union of keys preserves first-seen order.
  const names = [];
  const seen = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
    }
  }
  const columns = names.map((name) => {
    let missing = 0;
    let lenSum = 0;
    let nNum = 0;
    let nDate = 0;
    let hasSpace = false;
    const distinctSet = new Set();
    let nonMissing = 0;
    for (const r of rows) {
      const v = r[name];
      if (isMissing(v)) {
        missing++;
        continue;
      }
      nonMissing++;
      const s = typeof v === "string" ? v : String(v);
      lenSum += s.length;
      if (distinctSet.size <= 10000) distinctSet.add(s);
      if (typeof v === "number" || looksNumeric(s)) nNum++;
      else if (looksDate(s)) nDate++;
      if (!hasSpace && s.includes(" ")) hasSpace = true;
    }
    const distinct = distinctSet.size;
    const meanLen = nonMissing ? lenSum / nonMissing : 0;
    const stats = { distinct, meanLen: Math.round(meanLen * 100) / 100, missing };
    const n = nonMissing;

    let role;
    let confidence;
    if (n === 0) {
      role = "ignore";
      confidence = 0.95;
    } else if (name.startsWith("__")) {
      role = "ignore"; // internal columns like __sheet, __extraN
      confidence = 0.99;
    } else if (nNum / n > 0.9) {
      // unique integer-ish column with id-ish name is an id, not a measure
      if (distinct === n && ID_NAME_RE.test(name)) {
        role = "id";
        confidence = 0.85;
      } else {
        role = "numeric";
        confidence = 0.6 + 0.4 * (nNum / n);
      }
    } else if (nDate / n > 0.8) {
      role = "date";
      confidence = 0.55 + 0.45 * (nDate / n);
    } else if (distinct === n && n > 2 && !hasSpace && meanLen <= 40) {
      role = "id"; // unique short token-like values
      confidence = 0.8;
    } else if (meanLen > 40 || (distinct > 20 && meanLen > 25)) {
      role = "text";
      confidence = meanLen > 40 ? 0.9 : 0.75;
    } else {
      role = "categorical";
      confidence = distinct <= Math.max(12, n / 10) ? 0.8 : 0.5;
    }
    return { name, role, confidence: Math.min(1, Math.round(confidence * 100) / 100), stats };
  });
  return { columns };
}

// Convenience for unitize: best text column by (role, meanLen).
export function bestTextColumn(rows) {
  const { columns } = detect(rows);
  const texts = columns.filter((c) => c.role === "text");
  if (texts.length === 0) return null;
  texts.sort((a, b) => b.stats.meanLen - a.stats.meanLen);
  return texts[0].name;
}
