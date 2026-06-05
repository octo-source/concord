// Tests for the Concord dictionary engine (Task E).
// Run: node --test tests/unit/dictionary.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  tokenize,
  compile,
  score,
  hits,
  parseDic,
  toDic,
  importTsvLexicon,
} from "../../server/instruments/dictionary.js";
import { mulberry32, randInt } from "../../server/core/rng.js";

const LEX_DIR = new URL("../../server/lexicons/", import.meta.url);
const loadLexicon = (file) =>
  JSON.parse(readFileSync(new URL(file, LEX_DIR), "utf8"));

// vader.json carries raw VADER entries including emoticons whose "*" is not a
// trailing wildcard (e.g. "*\\0/*"). compile() rejects misplaced "*", so
// payload builders drop those entries (they could never tokenize-match anyway).
const wellFormedTermEntries = (terms) =>
  Object.entries(terms).filter(([term]) => {
    const star = term.indexOf("*");
    return star === -1 || star === term.length - 1;
  });

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b} (±${eps})`);

// A tiny payload used by several tests.
const tinyPayload = {
  categories: [
    { name: "posemo", terms: [{ term: "happy" }] },
    { name: "pay", terms: [{ term: "pay" }] },
  ],
  negation: { enabled: true, window: 3 },
  scoring: "count",
};

// ---------------------------------------------------------------- tokenize

test("tokenize: lowercase, apostrophes kept inside tokens", () => {
  assert.deepEqual(tokenize("Don't worry, be HAPPY!"), [
    "don't",
    "worry",
    "be",
    "happy",
  ]);
});

test("tokenize: curly apostrophe normalized to straight", () => {
  assert.deepEqual(tokenize("I don’t care"), ["i", "don't", "care"]);
});

test("tokenize: Spanish accented words stay intact", () => {
  assert.deepEqual(tokenize("La gestión era terrible, ¿no?"), [
    "la",
    "gestión",
    "era",
    "terrible",
    "no",
  ]);
});

test("tokenize: digits are word characters", () => {
  assert.deepEqual(tokenize("My 401k match"), ["my", "401k", "match"]);
});

test("tokenize: quotes around words are not part of tokens", () => {
  assert.deepEqual(tokenize(`'tis "quoted" text’`), ["tis", "quoted", "text"]);
});

test("tokenize: empty and punctuation-only strings", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("—…!?  \n"), []);
});

// ------------------------------------------------------- hand-count scoring

test("hand count: 'I am not happy with my pay' (count scoring)", () => {
  const [r] = score(["I am not happy with my pay"], tinyPayload);
  assert.equal(r.NOT_posemo, 1);
  assert.equal(r.posemo, 0);
  assert.equal(r.pay, 1);
  assert.equal(r.NOT_pay, 0);
});

test("hand count: percentOfWords exact to 1e-9 (7 tokens)", () => {
  const payload = { ...tinyPayload, scoring: "percentOfWords" };
  const [r] = score(["I am not happy with my pay"], payload);
  approx(r.pay, 100 / 7);
  approx(r.NOT_posemo, 100 / 7);
  assert.equal(r.posemo, 0);
});

test("negation window boundary: exactly window away flips, beyond does not", () => {
  const payload = {
    categories: [{ name: "posemo", terms: [{ term: "happy" }] }],
    negation: { enabled: true, window: 2 },
    scoring: "count",
  };
  // "not very happy": not at index 0, happy at index 2 → distance 2 ≤ window 2
  const [a] = score(["not very happy"], payload);
  assert.equal(a.NOT_posemo, 1);
  assert.equal(a.posemo, 0);
  // "not so very happy": distance 3 > window 2 → no flip
  const [b] = score(["not so very happy"], payload);
  assert.equal(b.posemo, 1);
  assert.equal(b.NOT_posemo, 0);
});

test("negation: n't suffix acts as negator", () => {
  const payload = {
    categories: [{ name: "posemo", terms: [{ term: "like" }] }],
    negation: { enabled: true, window: 3 },
    scoring: "count",
  };
  const [r] = score(["I don't like my manager"], payload);
  assert.equal(r.NOT_posemo, 1);
  assert.equal(r.posemo, 0);
});

test("negation disabled: no NOT_ keys at all", () => {
  const payload = { ...tinyPayload, negation: { enabled: false, window: 3 } };
  const [r] = score(["I am not happy with my pay"], payload);
  assert.equal(r.posemo, 1);
  assert.ok(!("NOT_posemo" in r));
});

test("unit of only negators scores 0 and is not empty", () => {
  const [r] = score(["not never no"], tinyPayload);
  assert.equal(r.posemo, 0);
  assert.equal(r.NOT_posemo, 0);
  assert.equal(r.pay, 0);
  assert.ok(!("empty" in r));
});

// ------------------------------------------------------------------ empties

test("empty units score 0 with empty: true marker", () => {
  const rs = score(["", "—!!?", "pay"], tinyPayload);
  assert.equal(rs[0].empty, true);
  assert.equal(rs[0].pay, 0);
  assert.equal(rs[1].empty, true);
  assert.equal(rs[1].posemo, 0);
  assert.ok(!("empty" in rs[2]));
  assert.equal(rs[2].pay, 1);
});

test("empty unit percentOfWords does not divide by zero", () => {
  const payload = { ...tinyPayload, scoring: "percentOfWords" };
  const [r] = score([""], payload);
  assert.equal(r.pay, 0);
  assert.equal(r.empty, true);
});

// ---------------------------------------------------------------- wildcards

test("wildcard underpa* matches underpaid/underpay/underpays, not under", () => {
  const payload = {
    categories: [{ name: "pay", terms: [{ term: "underpa*" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["underpaid underpay underpays under"], payload);
  assert.equal(r.pay, 3);
  const h = hits("underpaid underpay underpays under", payload);
  assert.equal(h.length, 3);
  for (const hit of h) assert.equal(hit.term, "underpa*");
});

test("wildcard matches the bare prefix itself (zero-or-more chars)", () => {
  const payload = {
    categories: [{ name: "pay", terms: [{ term: "pay*" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["pay payment pays paid"], payload);
  assert.equal(r.pay, 3); // pay, payment, pays — not "paid"
});

test("misplaced wildcards (under*pay, *pay) throw DICTIONARY_INVALID naming the term; trailing underpa* still works", () => {
  const mk = (term) => ({
    categories: [{ name: "pay", terms: [{ term }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  });
  // Infix star must not silently become the phrase "under pay".
  assert.throws(
    () => compile(mk("under*pay")),
    (e) =>
      e.name === "ConcordError" &&
      e.code === "DICTIONARY_INVALID" &&
      e.message.includes("under*pay")
  );
  // Leading star must not silently become exact "pay".
  assert.throws(
    () => compile(mk("*pay")),
    (e) =>
      e.name === "ConcordError" &&
      e.code === "DICTIONARY_INVALID" &&
      e.message.includes("*pay")
  );
  // Trailing star remains the supported wildcard form.
  const [r] = score(["underpaid"], mk("underpa*"));
  assert.equal(r.pay, 1);
});

test("wildcard with astral-plane characters matches (trie is code-unit keyed)", () => {
  // 𐌰/𐌱/𐌲 are Gothic letters outside the BMP: two UTF-16 code units each.
  const payload = {
    categories: [{ name: "gothic", terms: [{ term: "𐌰𐌱*" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["𐌰𐌱𐌲 𐌰𐌱 𐌰"], payload);
  assert.equal(r.gothic, 2); // 𐌰𐌱𐌲 and bare 𐌰𐌱 — not lone 𐌰
});

// ------------------------------------------------------------------ phrases

test('phrase "work life balance" matches and counts 3 tokens in percentOfWords', () => {
  const payload = {
    categories: [{ name: "balance", terms: [{ term: '"work life balance"' }] }],
    negation: { enabled: false, window: 3 },
    scoring: "percentOfWords",
  };
  const text = "I need work life balance"; // 5 tokens
  const [r] = score([text], payload);
  approx(r.balance, (100 * 3) / 5);

  const countPayload = { ...payload, scoring: "count" };
  const [c] = score([text], countPayload);
  assert.equal(c.balance, 1); // one phrase hit

  const h = hits(text, payload);
  assert.equal(h.length, 1);
  assert.equal(text.slice(h[0].start, h[0].end), "work life balance");
});

test("phrase matches across punctuation (work-life balance)", () => {
  const payload = {
    categories: [{ name: "balance", terms: [{ term: '"work life balance"' }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["good work-life balance here"], payload);
  assert.equal(r.balance, 1);
});

test("phrase at the very end of text matches; partial phrase does not", () => {
  const payload = {
    categories: [{ name: "balance", terms: [{ term: '"work life balance"' }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [end] = score(["I want work life balance"], payload);
  assert.equal(end.balance, 1);
  const [partial] = score(["I want work life"], payload);
  assert.equal(partial.balance, 0);
});

test("phrase under negation flips into NOT_ category", () => {
  const payload = {
    categories: [{ name: "balance", terms: [{ term: '"work life balance"' }] }],
    negation: { enabled: true, window: 3 },
    scoring: "count",
  };
  const [r] = score(["no work life balance"], payload);
  assert.equal(r.NOT_balance, 1);
  assert.equal(r.balance, 0);
  const h = hits("no work life balance", payload);
  assert.equal(h.length, 1);
  assert.equal(h[0].category, "NOT_balance");
});

test("unquoted multi-word term is treated as a phrase", () => {
  const payload = {
    categories: [{ name: "quit", terms: [{ term: "two weeks" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["I gave my two weeks yesterday"], payload);
  assert.equal(r.quit, 1);
});

// -------------------------------------------------------------------- hits

test("hits: character spans land exactly on the matched word", () => {
  const text = "I am not happy with my pay";
  const h = hits(text, tinyPayload);
  assert.equal(h.length, 2);
  const byCat = Object.fromEntries(h.map((x) => [x.category, x]));
  assert.equal(text.slice(byCat.NOT_posemo.start, byCat.NOT_posemo.end), "happy");
  assert.equal(byCat.NOT_posemo.term, "happy");
  assert.equal(text.slice(byCat.pay.start, byCat.pay.end), "pay");
});

test("hits: overlapping categories are all reported", () => {
  const payload = {
    categories: [
      { name: "catA", terms: [{ term: "pay" }] },
      { name: "catB", terms: [{ term: "pay" }] },
    ],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const h = hits("my pay stinks", payload);
  assert.equal(h.length, 2);
  assert.deepEqual(new Set(h.map((x) => x.category)), new Set(["catA", "catB"]));
  assert.equal(h[0].start, h[1].start);
  assert.equal(h[0].end, h[1].end);
});

test("hits accepts a unit object with .text", () => {
  const h = hits({ id: "u1", text: "my pay" }, tinyPayload);
  assert.equal(h.length, 1);
  assert.equal(h[0].category, "pay");
});

test("hits: spans sliced from MIXED-CASE original text return the original casing", () => {
  // Tokens are lowercased for matching, but spans index the verbatim text.
  const text = "I am HAPPY with my PAY";
  const h = hits(text, tinyPayload);
  const happy = h.find((x) => x.term === "happy");
  assert.equal(text.slice(happy.start, happy.end), "HAPPY");
  const pay = h.find((x) => x.term === "pay");
  assert.equal(text.slice(pay.start, pay.end), "PAY");
});

// ------------------------------------------------------------- scoring modes

test("binary scoring is 0/1 regardless of hit count", () => {
  const payload = { ...tinyPayload, negation: { enabled: false, window: 3 }, scoring: "binary" };
  const [a, b] = score(["pay pay pay happy", "nothing relevant here"], payload);
  assert.equal(a.pay, 1);
  assert.equal(a.posemo, 1);
  assert.equal(b.pay, 0);
  assert.equal(b.posemo, 0);
});

test("count scoring sums term weights (default weight 1)", () => {
  const payload = {
    categories: [
      {
        name: "valence",
        terms: [
          { term: "great", weight: 3 },
          { term: "fine", weight: 0.5 },
          { term: "ok" },
        ],
      },
    ],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["great great fine ok"], payload);
  approx(r.valence, 3 + 3 + 0.5 + 1);
});

test("percentOfWords counts unique token positions per category (no >100%)", () => {
  const payload = {
    categories: [
      { name: "pay", terms: [{ term: "pay" }, { term: "pay*" }] }, // both match "pay"
    ],
    negation: { enabled: false, window: 3 },
    scoring: "percentOfWords",
  };
  const [r] = score(["pay"], payload);
  approx(r.pay, 100); // one token matched twice still = 100%, not 200%
});

test("count mode does NOT dedupe positions: pay + pay* on one token sums to 2", () => {
  // Twin of the percentOfWords overlap test above. count sums EVERY raw hit's
  // weight — a token matched by two terms of the same category contributes
  // twice. This asymmetry is intentional and documented in score().
  const payload = {
    categories: [
      { name: "pay", terms: [{ term: "pay" }, { term: "pay*" }] }, // both match "pay"
    ],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["pay"], payload);
  assert.equal(r.pay, 2);
});

// ----------------------------------------------------------- compile() reuse

test("compile once, score many: compiled matcher gives identical results", () => {
  const m = compile(tinyPayload);
  const units = ["I am not happy with my pay", "happy pay day"];
  assert.deepEqual(score(units, m), score(units, tinyPayload));
  assert.deepEqual(hits(units[0], m), hits(units[0], tinyPayload));
});

test("compile validates payload", () => {
  assert.throws(
    () => compile({ categories: [], negation: { enabled: false, window: 3 }, scoring: "nope" }),
    (e) => e.name === "ConcordError" && e.code === "DICTIONARY_INVALID"
  );
  assert.throws(
    () => compile({ scoring: "count" }),
    (e) => e.name === "ConcordError" && e.code === "DICTIONARY_INVALID"
  );
});

test("compile memoizes raw payloads: repeated compile()/hits() reuse one matcher", () => {
  const payload = {
    categories: [{ name: "pay", terms: [{ term: "pay" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const m1 = compile(payload);
  const m2 = compile(payload);
  assert.equal(m1, m2); // reference-equal: second compile is a WeakMap cache hit
  assert.equal(compile(m1), m1); // a compiled matcher still passes through untouched
  // hits() with the same raw payload object twice goes through the memo too.
  assert.deepEqual(hits("my pay", payload), hits("my pay", payload));
});

test('reserved category names "empty" and NOT_* throw DICTIONARY_INVALID', () => {
  const mk = (name) => ({
    categories: [{ name, terms: [{ term: "x" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  });
  for (const name of ["empty", "NOT_pay"]) {
    assert.throws(
      () => compile(mk(name)),
      (e) => e.name === "ConcordError" && e.code === "DICTIONARY_INVALID",
      `category "${name}" must be rejected (collides with result keys)`
    );
  }
});

test("score() rejects non-array units (a bare string must not score per character)", () => {
  assert.throws(
    () => score("hello", tinyPayload),
    (e) => e.name === "ConcordError" && e.code === "DICTIONARY_INVALID"
  );
});

test("negation.window: zero, negative, and non-integer values throw", () => {
  const mk = (window) => ({
    categories: [{ name: "posemo", terms: [{ term: "happy" }] }],
    negation: { enabled: true, window },
    scoring: "count",
  });
  for (const window of [0, -1, 2.5, "3", NaN]) {
    assert.throws(
      () => compile(mk(window)),
      (e) => e.name === "ConcordError" && e.code === "DICTIONARY_INVALID",
      `window=${String(window)} must be rejected`
    );
  }
});

test("negation.window absent still defaults to 3", () => {
  const payload = {
    categories: [{ name: "posemo", terms: [{ term: "happy" }] }],
    negation: { enabled: true },
    scoring: "count",
  };
  const [flip] = score(["not a b happy"], payload); // distance 3 == default window
  assert.equal(flip.NOT_posemo, 1);
  const [keep] = score(["not a b c happy"], payload); // distance 4 > default window
  assert.equal(keep.posemo, 1);
});

// ------------------------------------------------------------------- .dic IO

test("parseDic parses the LIWC format", () => {
  const dic = [
    "%",
    "1\tposemo",
    "2\tnegemo",
    "%",
    "happy\t1",
    "sad\t2",
    "abandon*\t2",
    "grateful\t1",
    "bittersweet\t1\t2",
  ].join("\n");
  const { payload: p, warnings } = parseDic(dic);
  assert.deepEqual(warnings, []); // nothing skipped in a clean file
  assert.deepEqual(p.scoring, "percentOfWords");
  assert.deepEqual(p.negation, { enabled: false, window: 3 });
  assert.deepEqual(
    p.categories.map((c) => c.name),
    ["posemo", "negemo"]
  );
  const posemo = p.categories[0].terms.map((t) => t.term);
  const negemo = p.categories[1].terms.map((t) => t.term);
  assert.deepEqual(posemo, ["happy", "grateful", "bittersweet"]);
  assert.deepEqual(negemo, ["sad", "abandon*", "bittersweet"]);
});

test("parseDic(toDic(payload)) round-trips modulo ordering", () => {
  const payload = {
    categories: [
      { name: "posemo", terms: [{ term: "happy" }, { term: "grate*" }, { term: "bittersweet" }] },
      { name: "negemo", terms: [{ term: "sad" }, { term: "bittersweet" }, { term: "work life balance" }] },
    ],
    negation: { enabled: false, window: 3 },
    scoring: "percentOfWords",
  };
  const { payload: round, warnings } = parseDic(toDic(payload));
  assert.deepEqual(warnings, []);
  const norm = (p) => ({
    ...p,
    categories: p.categories.map((c) => ({
      name: c.name,
      terms: [...c.terms].sort((a, b) => a.term.localeCompare(b.term)),
    })),
  });
  assert.deepEqual(norm(round), norm(payload));
});

test("toDic refuses weighted payloads (.dic cannot express weights)", () => {
  const payload = {
    categories: [{ name: "v", terms: [{ term: "good", weight: 2 }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  assert.throws(
    () => toDic(payload),
    (e) => e.name === "ConcordError" && e.code === "DICTIONARY_UNSUPPORTED"
  );
});

test("parseDic rejects malformed input", () => {
  assert.throws(
    () => parseDic("no header here"),
    (e) => e.name === "ConcordError" && e.code === "DICTIONARY_PARSE"
  );
  assert.throws(
    () => parseDic("%\n1\tposemo\n%\nhappy\t99"),
    (e) => e.name === "ConcordError" && e.code === "DICTIONARY_PARSE" && e.details.line === 4
  );
});

test("parseDic skips LIWC conditional lines with warnings, parses the rest", () => {
  // Real LIWC 2007/2015 files carry parenthesized conditional entries; they
  // are not expressible as plain terms, so they skip with a warning instead
  // of failing the whole import.
  const dic = [
    "%",
    "1\tposemo",
    "2\tnegemo",
    "%",
    "happy\t1",
    "like\t(2 134)2/96",
    "kind\t(125 126)/(2 134)",
    "sad\t2",
  ].join("\n");
  const { payload, warnings } = parseDic(dic);
  assert.deepEqual(
    payload.categories[0].terms.map((t) => t.term),
    ["happy"]
  );
  assert.deepEqual(
    payload.categories[1].terms.map((t) => t.term),
    ["sad"]
  );
  assert.deepEqual(warnings, [
    { line: 6, term: "like", reason: "LIWC conditional syntax unsupported" },
    { line: 7, term: "kind", reason: "LIWC conditional syntax unsupported" },
  ]);
});

test("toDic rejects tabs and newlines in category names and terms", () => {
  const mk = (categories) => ({
    categories,
    negation: { enabled: false, window: 3 },
    scoring: "count",
  });
  const cases = [
    [{ name: "bad\tname", terms: [{ term: "x" }] }],
    [{ name: "bad\nname", terms: [{ term: "x" }] }],
    [{ name: "ok", terms: [{ term: "bad\tterm" }] }],
    [{ name: "ok", terms: [{ term: "bad\nterm" }] }],
  ];
  for (const categories of cases) {
    assert.throws(
      () => toDic(mk(categories)),
      (e) => e.name === "ConcordError" && e.code === "DICTIONARY_UNSUPPORTED",
      `${JSON.stringify(categories[0])} must be rejected`
    );
  }
});

// --------------------------------------------------------- TSV lexicon import

test("importTsvLexicon handles NRC EmoLex-style TSV", () => {
  const tsv = [
    "aback\tanger\t0",
    "abandon\tfear\t1",
    "abandon\tsadness\t1",
    "abuse\tanger\t1",
  ].join("\n");
  const p = importTsvLexicon(tsv, { termCol: 0, categoryCol: 1, valueCol: 2 });
  assert.deepEqual(
    p.categories.map((c) => c.name),
    ["fear", "sadness", "anger"]
  );
  assert.deepEqual(p.categories[0].terms, [{ term: "abandon" }]);
  assert.deepEqual(p.categories[2].terms, [{ term: "abuse" }]);
  assert.equal(p.scoring, "percentOfWords");
});

test("importTsvLexicon keeps non-binary values as weights", () => {
  const tsv = ["fury\tanger\t0.93", "irritated\tanger\t0.4"].join("\n");
  const p = importTsvLexicon(tsv, { termCol: 0, categoryCol: 1, valueCol: 2 });
  assert.deepEqual(p.categories[0].terms, [
    { term: "fury", weight: 0.93 },
    { term: "irritated", weight: 0.4 },
  ]);
});

test("importTsvLexicon without valueCol takes every row", () => {
  const tsv = ["salary\tpay", "boss\tmanagement"].join("\n");
  const p = importTsvLexicon(tsv, { termCol: 0, categoryCol: 1 });
  assert.deepEqual(
    p.categories.map((c) => c.name),
    ["pay", "management"]
  );
});

test("importTsvLexicon rejects rows missing columns", () => {
  assert.throws(
    () => importTsvLexicon("onlyonefield", { termCol: 0, categoryCol: 1 }),
    (e) => e.name === "ConcordError" && e.code === "DICTIONARY_PARSE"
  );
});

// ------------------------------------------------------------------ Spanish

test("Spanish unit scores against a Spanish term", () => {
  const payload = {
    categories: [{ name: "negemo", terms: [{ term: "terrible" }] }],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const [r] = score(["La gestión era terrible"], payload);
  assert.equal(r.negemo, 1);
});

// ----------------------------------------------------------------- lexicons

test("vader.json loads and separates positive from negative", () => {
  const vader = loadLexicon("vader.json");
  assert.ok(vader.name.startsWith("VADER"));
  assert.ok(vader.license === "MIT" || vader.note); // full fetch or labeled fallback
  const entries = wellFormedTermEntries(vader.terms);
  assert.ok(entries.length >= 150, `expected >=150 terms, got ${entries.length}`);
  const payload = {
    categories: [
      { name: "valence", terms: entries.map(([term, weight]) => ({ term, weight })) },
    ],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const m = compile(payload);
  const [pos, neg] = score(
    ["I love this wonderful great product", "I hate this terrible awful product"],
    m
  );
  assert.ok(pos.valence > 0, `positive sum ${pos.valence} should be > 0`);
  assert.ok(neg.valence < 0, `negative sum ${neg.valence} should be < 0`);
});

test("VADER multiword entries match end-to-end through score and hits (fed up)", () => {
  const vader = loadLexicon("vader.json");
  assert.ok("fed up" in vader.terms, "vader.json must carry the 'fed up' phrase");
  const entries = wellFormedTermEntries(vader.terms);
  const payload = {
    categories: [
      { name: "valence", terms: entries.map(([term, weight]) => ({ term, weight })) },
    ],
    negation: { enabled: false, window: 3 },
    scoring: "count",
  };
  const m = compile(payload);
  const text = "I am fed up with this";
  const h = hits(text, m);
  assert.equal(h.length, 1, "the phrase should be the only VADER hit in this sentence");
  assert.equal(h[0].term, "fed up");
  assert.equal(h[0].category, "valence");
  assert.equal(text.slice(h[0].start, h[0].end), "fed up");
  const [r] = score([text], m);
  approx(r.valence, vader.terms["fed up"]); // −1.8, from the phrase alone
});

const starterSpecs = [
  {
    file: "starter-emotions.json",
    cats: ["joy", "sadness", "anger", "fear", "trust", "disgust", "surprise", "anticipation"],
    minTerms: 35,
  },
  {
    file: "starter-moral.json",
    cats: ["care", "fairness", "loyalty", "authority", "sanctity"],
    minTerms: 25,
  },
  {
    file: "starter-work.json",
    cats: ["pay", "management", "workload", "growth", "remote", "quit"],
    minTerms: 25,
  },
];

for (const spec of starterSpecs) {
  test(`${spec.file}: structure, headers, term hygiene`, () => {
    const lex = loadLexicon(spec.file);
    assert.equal(lex.license, "CC0");
    assert.equal(lex.origin, "Concord starter lexicon");
    assert.deepEqual(
      lex.categories.map((c) => c.name),
      spec.cats
    );
    // Compiles cleanly.
    const noNeg = { ...lex, negation: { enabled: false, window: 3 } };
    compile(noNeg);
    for (const cat of lex.categories) {
      assert.ok(
        cat.terms.length >= spec.minTerms,
        `${spec.file} ${cat.name}: ${cat.terms.length} terms < ${spec.minTerms}`
      );
      const seen = new Set();
      for (const { term } of cat.terms) {
        assert.equal(term, term.toLowerCase(), `${term} must be lowercase`);
        assert.ok(!seen.has(term), `duplicate term ${term} in ${cat.name}`);
        seen.add(term);
        // Every term must match itself when scored (catches typos that the
        // tokenizer would split into something unmatchable).
        const literal = term.replaceAll('"', "").replaceAll("*", "");
        const h = hits(literal, noNeg);
        assert.ok(
          h.some((x) => x.category === cat.name),
          `${spec.file}: term "${term}" fails to match its own text`
        );
      }
    }
  });
}

test("starter-work: signature terms present", () => {
  const lex = loadLexicon("starter-work.json");
  const terms = Object.fromEntries(
    lex.categories.map((c) => [c.name, new Set(c.terms.map((t) => t.term))])
  );
  assert.ok(terms.pay.has("salary"));
  assert.ok(terms.pay.has("underpaid") || terms.pay.has("underpa*"));
  assert.ok(terms.quit.has("resign") || terms.quit.has("resign*"));
  assert.ok(terms.quit.has("two weeks"));
});

// -------------------------------------------------------------- determinism

test("determinism: identical inputs give deep-equal outputs", () => {
  const units = ["I am not happy with my pay", "", "work life balance now"];
  const a = score(units, tinyPayload);
  const b = score(units, tinyPayload);
  assert.deepEqual(a, b);
  assert.deepEqual(hits(units[0], tinyPayload), hits(units[0], tinyPayload));
});

// --------------------------------------------------------------------- perf

test("perf: 50k synthetic units against starter-work in < 5s", () => {
  const lex = loadLexicon("starter-work.json");
  const rand = mulberry32(42);
  const filler = (
    "the a my our this that it we they i you was is are were been being have has had do " +
    "did will would could should about with from into over under after before because so " +
    "and or but if then very really quite just also even still here there when where team " +
    "people company year day week month thing place time good bad new old big small"
  ).split(" ");
  const lexTerms = [];
  for (const cat of lex.categories)
    for (const { term } of cat.terms)
      lexTerms.push(term.replaceAll('"', "").replaceAll("*", ""));
  const vocab = filler.concat(lexTerms.filter((_, i) => i % 3 === 0));
  const units = new Array(50000);
  for (let u = 0; u < 50000; u++) {
    const n = 16 + randInt(rand, 9); // ~16–24 tokens
    const words = new Array(n);
    for (let w = 0; w < n; w++) words[w] = vocab[randInt(rand, vocab.length)];
    units[u] = words.join(" ");
  }
  const t0 = process.hrtime.bigint();
  const results = score(units, lex);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(results.length, 50000);
  // Sanity: the corpus must actually contain hits.
  const total = results.reduce((s, r) => s + r.pay + r.quit, 0);
  assert.ok(total > 0, "synthetic corpus produced no hits — vocab broken");
  assert.ok(ms < 5000, `scoring took ${ms.toFixed(0)}ms, budget 5000ms`);
  console.log(`    perf: 50k units scored in ${ms.toFixed(0)}ms`);
});
