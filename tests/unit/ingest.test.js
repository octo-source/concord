// Task C — Ingestion test suite. Run: node --test tests/unit/ingest.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as csv from "../../server/ingest/csv.js";
import * as xlsx from "../../server/ingest/xlsx.js";
import * as docx from "../../server/ingest/docx.js";
import * as pdf from "../../server/ingest/pdf.js";
import * as text from "../../server/ingest/text.js";
import * as transcript from "../../server/ingest/transcript.js";
import * as mapping from "../../server/ingest/mapping.js";
import { unitize } from "../../server/ingest/unitize.js";
import * as junk from "../../server/ingest/junk.js";
import * as pii from "../../server/ingest/pii.js";
import { unitId } from "../../server/core/ids.js";
import { mulberry32, randInt } from "../../server/core/rng.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fix = (name) => join(FIX, name);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "concord-ingest-"));
}

// =============================================================== csv.js

test("csv: BOM, quoted newlines, doubled-quote escapes, exact cells", async () => {
  const { rows, issues } = await csv.parse(fix("ingest-basic.csv"));
  assert.equal(rows.length, 5);
  // BOM stripped: first header is plain "id"
  assert.deepEqual(Object.keys(rows[0]), ["id", "response", "score"]);
  assert.equal(rows[0].id, "r1");
  assert.equal(rows[0].response, 'She said "hello" to me');
  assert.equal(rows[0].score, "4");
  // embedded newline survives inside one cell
  assert.equal(rows[1].response, "First line\nsecond line of same cell");
  assert.equal(rows[1].score, "5");
  // ragged row padded + issue recorded
  assert.equal(rows[2].id, "r3");
  assert.equal(rows[2].response, "short answer");
  assert.equal(rows[2].score, "");
  assert.ok(issues.some((i) => i.kind === "ragged_row" && i.row === 2));
  // Spanish text intact (UTF-8) with embedded comma in quotes
  assert.equal(rows[3].response, "La gestión era terrible, pero el equipo increíble");
  assert.equal(rows[4].response, "plain text");
});

test("csv: semicolon delimiter sniffed", async () => {
  const { rows, issues } = await csv.parse(fix("ingest-semicolon.csv"));
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ["name", "city", "notes"]);
  assert.equal(rows[0].notes, "uses, commas; here");
  assert.equal(rows[1].city, "Lisbon");
  assert.equal(issues.length, 0);
});

test("csv: tab delimiter sniffed", async () => {
  const dir = tempDir();
  const p = join(dir, "t.tsv");
  writeFileSync(p, "a\tb\n1\tx y\n2\tz\n");
  const { rows } = await csv.parse(p);
  assert.deepEqual(rows, [{ a: "1", b: "x y" }, { a: "2", b: "z" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("csv: headerless numeric file gets synthesized names + issue", async () => {
  const dir = tempDir();
  const p = join(dir, "nohead.csv");
  writeFileSync(p, "1,2,3\n4,5,6\n");
  const { rows, issues } = await csv.parse(p);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ["col1", "col2", "col3"]);
  assert.equal(rows[0].col1, "1");
  assert.ok(issues.some((i) => i.kind === "no_header"));
  rmSync(dir, { recursive: true, force: true });
});

test("csv: empty file -> zero rows + issue, no crash", async () => {
  const dir = tempDir();
  const p = join(dir, "empty.csv");
  writeFileSync(p, "");
  const { rows, issues } = await csv.parse(p);
  assert.deepEqual(rows, []);
  assert.ok(issues.some((i) => i.kind === "empty"));
  rmSync(dir, { recursive: true, force: true });
});

test("csv: single column file parses without delimiter", async () => {
  const dir = tempDir();
  const p = join(dir, "one.csv");
  writeFileSync(p, "comment\nfirst answer here\nsecond answer\n");
  const { rows } = await csv.parse(p);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ["comment"]);
  assert.equal(rows[1].comment, "second answer");
  rmSync(dir, { recursive: true, force: true });
});

test("csv: unterminated quote recovers with issue", async () => {
  const dir = tempDir();
  const p = join(dir, "bad.csv");
  writeFileSync(p, 'a,b\n1,"oops\n2,fine\n');
  const { rows, issues } = await csv.parse(p);
  assert.ok(rows.length >= 1);
  assert.ok(issues.some((i) => i.kind === "unterminated_quote"));
  rmSync(dir, { recursive: true, force: true });
});

test("csv: duplicate header names deduped with issue", async () => {
  const dir = tempDir();
  const p = join(dir, "dup.csv");
  writeFileSync(p, "x,x,y\n1,2,3\n");
  const { rows, issues } = await csv.parse(p);
  assert.deepEqual(Object.keys(rows[0]), ["x", "x_2", "y"]);
  assert.equal(rows[0].x, "1");
  assert.equal(rows[0].x_2, "2");
  assert.ok(issues.some((i) => i.kind === "dup_header"));
  rmSync(dir, { recursive: true, force: true });
});

test("csv: CR-only and mixed line endings", async () => {
  const dir = tempDir();
  const p = join(dir, "mix.csv");
  writeFileSync(p, "a,b\r\n1,2\n3,4\r\n");
  const { rows } = await csv.parse(p);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].b, "4");
  rmSync(dir, { recursive: true, force: true });
});

// =============================================================== xlsx.js

test("xlsx: three sheets -> rows tagged __sheet, dates ISO", async () => {
  const { rows, issues } = await xlsx.parse(fix("ingest-three-sheets.xlsx"));
  assert.equal(issues.length, 0);
  const sheets = [...new Set(rows.map((r) => r.__sheet))];
  assert.deepEqual(sheets, ["Wave1", "Wave2", "Stats"]);
  const w1 = rows.filter((r) => r.__sheet === "Wave1");
  assert.equal(w1.length, 2);
  assert.equal(w1[0].id, "a1");
  assert.equal(w1[0].answer, "Loved the workshop");
  assert.ok(String(w1[0].when).startsWith("2024-01-15"), `got ${w1[0].when}`);
  const w2 = rows.filter((r) => r.__sheet === "Wave2");
  assert.equal(w2[0].answer, "Second sheet row");
  const st = rows.filter((r) => r.__sheet === "Stats");
  assert.equal(Number(st[0].v), 3.14);
});

// =============================================================== docx.js

test("docx: mammoth extracts paragraphs with positions", async () => {
  const { docs, issues } = await docx.parse(fix("ingest-min.docx"));
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, "ingest-min.docx");
  assert.deepEqual(docs[0].paras, [
    "First paragraph from DOCX.",
    "Second paragraph with café text.",
    "Third one.",
  ]);
  assert.ok(Array.isArray(issues));
});

// =============================================================== pdf.js

test("pdf: extracts both text objects as two paragraphs with page anchors", async () => {
  const { docs, issues } = await pdf.parse(fix("ingest-min.pdf"));
  assert.equal(docs.length, 1);
  assert.equal(docs[0].paras.length, 2);
  assert.equal(docs[0].paras[0], "Hello from Concord PDF.");
  assert.equal(docs[0].paras[1], "Second paragraph here.");
  // page anchors recorded, parallel to paras
  assert.deepEqual(docs[0].pages, [1, 1]);
  assert.ok(Array.isArray(issues));
});

// =============================================================== text.js

test("text: txt splits paragraphs on blank lines", async () => {
  const { docs } = await text.parse(fix("ingest-sample.txt"));
  assert.equal(docs[0].paras.length, 3);
  assert.equal(docs[0].paras[0], "First paragraph of plain text.\nStill the first paragraph.");
  assert.equal(docs[0].paras[1], "Second paragraph here.");
  assert.equal(docs[0].paras[2], "Third paragraph after extra blanks.");
});

test("text: html strips tags/scripts/styles, keeps block boundaries", async () => {
  const { docs } = await text.parse(fix("ingest-sample.html"));
  const paras = docs[0].paras;
  assert.ok(paras.includes("Heading One"));
  assert.ok(paras.includes("First bold paragraph & more."));
  assert.ok(paras.some((p) => p.includes("Second block")));
  const all = paras.join("\n");
  assert.ok(!all.includes("color: red"), "style leaked");
  assert.ok(!all.includes("not text"), "script leaked");
  assert.ok(!all.includes("<"), "tag leaked");
});

// =============================================================== transcript.js

test("vtt: hour timestamps parsed, same-speaker cues merged", async () => {
  const { turns } = await transcript.parse(fix("ingest-sample.vtt"));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, "Alice");
  assert.equal(turns[0].text, "Hello everyone. Welcome to the meeting.");
  assert.equal(turns[0].t0, 1);
  assert.equal(turns[0].t1, 1 * 3600 + 2 * 60 + 6); // end of merged cue
  assert.equal(turns[1].speaker, "Bob");
  assert.equal(turns[1].t0, 1 * 3600 + 2 * 60 + 7);
  assert.equal(turns[1].t1, 1 * 3600 + 2 * 60 + 9.25);
});

test("srt: comma timestamps, speaker prefix, merge", async () => {
  const { turns } = await transcript.parse(fix("ingest-sample.srt"));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, "Alice");
  assert.equal(turns[0].text, "Hello there. How are you today?");
  assert.equal(turns[0].t0, 1);
  assert.equal(turns[0].t1, 6.5);
  assert.equal(turns[1].speaker, "Bob");
  assert.equal(turns[1].text, "Doing well, thanks.");
});

test("zoom json: speakers, times, merge", async () => {
  const { turns } = await transcript.parse(fix("ingest-zoom.json"));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, "Carol");
  assert.equal(turns[0].text, "Let us begin. First item is budget.");
  assert.equal(turns[0].t0, 1.2);
  assert.equal(turns[0].t1, 7);
  assert.equal(turns[1].speaker, "Dan");
});

// =============================================================== mapping.js

test("mapping: detects text/categorical/numeric/date/id on mixed table", () => {
  const rows = [];
  const cities = ["Austin", "Boston", "Chicago"];
  for (let i = 0; i < 60; i++) {
    rows.push({
      resp_id: `R${String(i + 1).padStart(3, "0")}`,
      city: cities[i % 3],
      age: String(20 + (i % 40)),
      joined: `2024-0${1 + (i % 9)}-1${i % 10}`,
      comment:
        "This is a long free-text answer describing my experience in detail, " +
        `variant number ${i} with extra words to push mean length up.`,
    });
  }
  const { columns } = mapping.detect(rows);
  const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
  assert.equal(byName.resp_id.role, "id");
  assert.equal(byName.city.role, "categorical");
  assert.equal(byName.age.role, "numeric");
  assert.equal(byName.joined.role, "date");
  assert.equal(byName.comment.role, "text");
  for (const c of columns) {
    assert.ok(c.confidence > 0 && c.confidence <= 1);
    assert.ok(c.stats && typeof c.stats.distinct === "number");
    assert.ok(typeof c.stats.meanLen === "number");
    assert.ok(typeof c.stats.missing === "number");
  }
});

test("mapping: >20 distinct values with meanLen>25 counts as text", () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ note: `medium length answer about topic ${i}` }); // ~35 chars, distinct
  }
  const { columns } = mapping.detect(rows);
  assert.equal(columns[0].role, "text");
});

test("mapping: missing values counted, mostly-empty column ignored", () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ a: "x", blank: "" });
  const { columns } = mapping.detect(rows);
  const blank = columns.find((c) => c.name === "blank");
  assert.equal(blank.stats.missing, 20);
  assert.equal(blank.role, "ignore");
});

test("mapping: empty rows -> empty columns, no crash", () => {
  assert.deepEqual(mapping.detect([]), { columns: [] });
});

test("mapping: US and EU date formats recognized", () => {
  const us = Array.from({ length: 10 }, (_, i) => ({ d: `0${1 + (i % 9)}/15/2024` }));
  const eu = Array.from({ length: 10 }, (_, i) => ({ d: `15.0${1 + (i % 9)}.2024` }));
  assert.equal(mapping.detect(us).columns[0].role, "date");
  assert.equal(mapping.detect(eu).columns[0].role, "date");
});

// =============================================================== unitize.js

const CORPUS = "c_test1";

test("unitize response: one unit per row, meta carries non-text cols", () => {
  const parsed = {
    rows: [
      { id: "r1", answer: "Great management, fair pay overall.", score: "4" },
      { id: "r2", answer: "Terrible hours and no flexibility at all.", score: "1" },
    ],
    issues: [],
  };
  const units = unitize(CORPUS, parsed, "response", { textColumn: "answer" });
  assert.equal(units.length, 2);
  assert.equal(units[0].text, "Great management, fair pay overall.");
  assert.deepEqual(units[0].meta, { id: "r1", score: "4" });
  assert.deepEqual(units[0].pos, { row: 0 });
  assert.equal(units[0].id, unitId(CORPUS, 0, units[0].text));
  assert.equal(units[1].id, unitId(CORPUS, 1, units[1].text));
});

test("unitize response: auto-detects text column when not given", () => {
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({
      id: `R${i}`,
      answer: `A fairly long free text response number ${i} that goes on and on a bit.`,
    });
  }
  const units = unitize(CORPUS, { rows, issues: [] }, "response");
  assert.equal(units.length, 25);
  assert.ok(units[0].text.startsWith("A fairly long"));
  assert.equal(units[0].meta.id, "R0");
});

test("unitize sentence: abbreviation guard — Dr. Smith case", () => {
  const parsed = { rows: [{ t: "Dr. Smith went home. She slept." }], issues: [] };
  const units = unitize(CORPUS, parsed, "sentence", { textColumn: "t" });
  assert.equal(units.length, 2);
  assert.equal(units[0].text, "Dr. Smith went home.");
  assert.equal(units[1].text, "She slept.");
});

test("unitize sentence: more abbreviation cases", () => {
  const cases = [
    ["I met Mr. Jones today. He was kind.", 2],
    ["See Fig. 3 for details. It is clear.", 2],
    ["We compared apples vs. oranges carefully.", 1],
    ["Costs rose, e.g. fuel and rent. Wages did not.", 2],
    ["She lives in the U.S. now.", 1],
    ["Prof. Lee et al. wrote it. Etc. aside, fine.", 2],
    ["One! Two? Three.", 3],
  ];
  for (const [textIn, n] of cases) {
    const units = unitize(CORPUS, { rows: [{ t: textIn }], issues: [] }, "sentence", { textColumn: "t" });
    assert.equal(units.length, n, `"${textIn}" -> expected ${n}, got ${units.map((u) => JSON.stringify(u.text))}`);
  }
});

test("unitize paragraph: docs -> one unit per para with doc/para pos", () => {
  const parsed = {
    docs: [
      { name: "a.txt", paras: ["Para one.", "Para two."] },
      { name: "b.txt", paras: ["Other doc."] },
    ],
    issues: [],
  };
  const units = unitize(CORPUS, parsed, "paragraph");
  assert.equal(units.length, 3);
  assert.deepEqual(units[0].pos, { doc: "a.txt", para: 0 });
  assert.deepEqual(units[2].pos, { doc: "b.txt", para: 0 });
  assert.equal(units[2].text, "Other doc.");
  assert.equal(units[0].meta.doc, "a.txt");
});

test("unitize turn: turns -> units with speaker/time pos + meta", () => {
  const parsed = {
    turns: [
      { speaker: "Alice", t0: 1, t1: 4, text: "Hello everyone." },
      { speaker: "Bob", t0: 5, t1: 9, text: "Hi Alice." },
    ],
    issues: [],
  };
  const units = unitize(CORPUS, parsed, "turn");
  assert.equal(units.length, 2);
  assert.deepEqual(units[0].pos, { turn: 0, speaker: "Alice", t0: 1, t1: 4 });
  assert.equal(units[0].meta.speaker, "Alice");
  assert.equal(units[1].text, "Hi Alice.");
});

test("unitize sentence on turns: splits within turns, keeps turn pos", () => {
  const parsed = {
    turns: [{ speaker: "A", t0: 0, t1: 5, text: "First point. Second point." }],
    issues: [],
  };
  const units = unitize(CORPUS, parsed, "sentence");
  assert.equal(units.length, 2);
  assert.equal(units[0].pos.turn, 0);
  assert.equal(units[0].pos.speaker, "A");
});

test("unitize: empty inputs give empty unit lists", () => {
  assert.deepEqual(unitize(CORPUS, { rows: [], issues: [] }, "response"), []);
  assert.deepEqual(unitize(CORPUS, { docs: [], issues: [] }, "paragraph"), []);
  assert.deepEqual(unitize(CORPUS, { turns: [], issues: [] }, "turn"), []);
});

test("unitize: blank text rows are skipped", () => {
  const parsed = { rows: [{ t: "Real answer here." }, { t: "" }, { t: "   " }], issues: [] };
  const units = unitize(CORPUS, parsed, "response", { textColumn: "t" });
  assert.equal(units.length, 1);
});

test("unitize response: id uses SOURCE row index even after skipped blanks", () => {
  const parsed = {
    rows: [{ t: "First answer." }, { t: "" }, { t: "Third row answer." }],
    issues: [],
  };
  const units = unitize(CORPUS, parsed, "response", { textColumn: "t" });
  assert.equal(units.length, 2);
  assert.deepEqual(units[1].pos, { row: 2 });
  assert.equal(units[1].id, unitId(CORPUS, 2, "Third row answer."));
});

test("unitize sentence: repeated identical sentences in one row get distinct ids", () => {
  const parsed = { rows: [{ t: "Yes I agree. Yes I agree." }], issues: [] };
  const units = unitize(CORPUS, parsed, "sentence", { textColumn: "t" });
  assert.equal(units.length, 2);
  assert.notEqual(units[0].id, units[1].id);
});

test("unitize: scheme/source mismatch throws ConcordError", () => {
  assert.throws(
    () => unitize(CORPUS, { rows: [{ t: "x" }], issues: [] }, "turn", { textColumn: "t" }),
    (e) => e.name === "ConcordError" && e.code === "BAD_SCHEME"
  );
});

// =============================================================== junk.js

function mkUnits(texts) {
  return texts.map((t, i) => ({ id: unitId("c_junk", i, t), text: t, meta: {}, pos: { row: i } }));
}

test("junk: na variants and keyboard mash flagged", () => {
  const units = mkUnits([
    "A real and reasonably long answer about work.",
    "N/A",
    "na",
    "None",
    "nothing",
    ".",
    "asdf",
    "asdfasdf",
    "qwerty",
    "Another genuine answer with plenty of words here.",
  ]);
  const { flagged, counts } = junk.scan(units);
  const naIds = flagged.filter((f) => f.kind === "na").map((f) => f.unitId);
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(naIds.includes(units[i].id), `unit ${i} "${units[i].text}" should be na`);
    assert.equal(units[i].flags.junk, "na");
  }
  assert.equal(counts.na, 8);
  assert.equal(units[0].flags?.junk, undefined);
});

test("junk: short flag when corpus median is long", () => {
  const long = Array.from({ length: 8 }, (_, i) => `A long enough answer number ${i} with many words.`);
  const units = mkUnits([...long, "too short"]);
  const { flagged } = junk.scan(units);
  const f = flagged.find((x) => x.kind === "short");
  assert.ok(f);
  assert.equal(f.unitId, units[8].id);
  assert.equal(units[8].flags.junk, "short");
});

test("junk: short NOT flagged when corpus median is short", () => {
  const units = mkUnits(["good", "bad", "fine", "ok sure", "meh"]);
  const { flagged, counts } = junk.scan(units);
  assert.equal(counts.short, 0);
  assert.ok(!flagged.some((f) => f.kind === "short"));
});

test("junk: dup flags the LATER copies and records original id", () => {
  const units = mkUnits([
    "The pay was too low for the workload involved.",
    "Different answer entirely about management style.",
    "  the pay was TOO low for the workload involved. ", // ws/case-normalized dup of 0
  ]);
  const { flagged } = junk.scan(units);
  const dups = flagged.filter((f) => f.kind === "dup");
  assert.equal(dups.length, 1);
  assert.equal(dups[0].unitId, units[2].id);
  assert.equal(dups[0].of, units[0].id);
  assert.equal(units[2].flags.junk, "dup");
  assert.equal(units[2].flags.dup, units[0].id);
  assert.equal(units[0].flags?.junk, undefined, "original not flagged");
});

test("junk: bot — three identical non-trivial texts all flagged", () => {
  const botText = "I love this product it is the best thing ever made.";
  const units = mkUnits([
    botText,
    "A genuine unique answer about workload and balance.",
    botText,
    botText,
    "Another distinct answer mentioning pay and growth.",
  ]);
  const { flagged, counts } = junk.scan(units);
  const bots = flagged.filter((f) => f.kind === "bot");
  assert.equal(bots.length, 3);
  for (const i of [0, 2, 3]) assert.equal(units[i].flags.junk, "bot");
  assert.equal(counts.bot, 3);
  // bot members are not double-reported as dup
  assert.ok(!flagged.some((f) => f.kind === "dup"));
});

test("junk: two identical texts are dup not bot; trivial repeats not bot", () => {
  const t = "This repeated answer has at least six tokens in it.";
  const units = mkUnits([t, t, "yes", "yes", "yes", "A unique long answer with lots of words inside."]);
  const { flagged } = junk.scan(units);
  assert.ok(!flagged.some((f) => f.kind === "bot"), "no bot flags expected");
  const dupF = flagged.filter((f) => f.kind === "dup");
  assert.ok(dupF.some((f) => f.unitId === units[1].id && f.of === units[0].id));
});

test("junk: all-junk corpus handled without crash", () => {
  const units = mkUnits(["n/a", "na", ".", "none", "asdf"]);
  const { flagged, counts } = junk.scan(units);
  assert.equal(flagged.length, 5);
  assert.equal(counts.na, 5);
});

test("junk: empty unit list", () => {
  const { flagged, counts } = junk.scan([]);
  assert.deepEqual(flagged, []);
  assert.equal(counts.na + counts.short + counts.dup + counts.bot, 0);
});

// =============================================================== pii.js

function mkPiiUnits(texts) {
  return texts.map((t, i) => ({ id: unitId("c_pii", i, t), text: t, meta: {}, pos: { row: i } }));
}

test("pii: scan finds emails, phones, ssn, user-urls, names", () => {
  const units = mkPiiUnits([
    "Contact me at jane.doe@example.com or call 555-867-5309 anytime.",
    "My manager John Smith ignored the report I sent him.",
    "SSN on file was 123-45-6789 which is alarming.",
    "Profile at https://user:pw@internal.example.org/path was exposed.",
    "Call +44 20 7946 0958 for the London office.",
    "Nothing sensitive in this perfectly ordinary sentence.",
  ]);
  const { findings } = pii.scan(units);
  const byId = Object.fromEntries(findings.map((f) => [f.unitId, f.spans]));
  const kinds = (u) => (byId[u.id] || []).map((s) => s.kind);

  assert.ok(kinds(units[0]).includes("email"));
  assert.ok(kinds(units[0]).includes("phone"));
  const emailSpan = byId[units[0].id].find((s) => s.kind === "email");
  assert.equal(units[0].text.slice(emailSpan.start, emailSpan.end), "jane.doe@example.com");

  assert.ok(kinds(units[1]).includes("name"));
  const nameSpan = byId[units[1].id].find((s) => s.kind === "name");
  assert.equal(units[1].text.slice(nameSpan.start, nameSpan.end), "John Smith");

  assert.ok(kinds(units[2]).includes("ssn"));
  assert.ok(kinds(units[3]).includes("url_user"));
  assert.ok(kinds(units[4]).includes("phone"));
  assert.equal(byId[units[5].id], undefined);
});

test("pii: name heuristic skips sentence starts and stoplisted bigrams", () => {
  const units = mkPiiUnits([
    "Many Thanks for everything you did.", // sentence start, skip
    "We moved to New York last spring.", // stoplisted geo term
    "Talked with Maria Garcia about it.", // genuine name
    "United States policy was discussed.", // stoplist
  ]);
  const { findings } = pii.scan(units);
  const flat = findings.flatMap((f) => f.spans.map((s) => ({ id: f.unitId, ...s })));
  const names = flat.filter((s) => s.kind === "name");
  assert.equal(names.length, 1);
  assert.equal(names[0].id, units[2].id);
});

test("pii: pseudonymize -> reidentify roundtrip, stable tokens, vault written", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  const units = mkPiiUnits([
    "Email jane.doe@example.com and also bob@test.org please.",
    "Then jane.doe@example.com wrote to John Smith again.",
  ]);
  const originals = units.map((u) => u.text);

  const { units: masked, vault } = await pii.pseudonymize(units, vaultPath);
  // originals untouched, masked is new
  assert.equal(units[0].text, originals[0]);
  assert.ok(masked[0].text.includes("[EMAIL_1]"));
  assert.ok(masked[0].text.includes("[EMAIL_2]"));
  // stable: same address -> same token in another unit
  assert.ok(masked[1].text.includes("[EMAIL_1]"));
  assert.ok(masked[1].text.includes("[NAME_1]"));
  assert.ok(!masked.some((u) => u.text.includes("jane.doe@example.com")));
  // ids preserved so labels stay linked
  assert.equal(masked[0].id, units[0].id);
  // vault file exists outside-bundle at caller path, reversible map inside
  assert.ok(existsSync(vaultPath));
  const v = JSON.parse(readFileSync(vaultPath, "utf8"));
  assert.equal(v.tokens["[EMAIL_1]"], "jane.doe@example.com");
  assert.equal(v.tokens["[NAME_1]"], "John Smith");
  assert.ok(vault.counts.email >= 2);

  const restored = await pii.reidentify(masked, vaultPath);
  assert.deepEqual(restored.map((u) => u.text), originals);
  rmSync(dir, { recursive: true, force: true });
});

test("pii: scan on clean units returns empty findings", () => {
  const { findings, counts } = pii.scan(mkPiiUnits(["just a plain sentence about work."]));
  assert.deepEqual(findings, []);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0);
});

// =============================================================== perf

test("perf: 10k-row CSV full pipeline < 10s", async () => {
  const dir = tempDir();
  const p = join(dir, "big.csv");
  const rand = mulberry32(42);
  const subjects = ["The manager", "My team", "Senior leadership", "The new policy", "Our schedule", "The pay structure"];
  const verbs = ["ignored", "improved", "ruined", "supported", "changed", "complicated"];
  const objects = ["our morale", "the workload", "every deadline", "my growth path", "the review process", "team flexibility"];
  const tails = [
    "and nobody explained why it happened.",
    "which made the quarter much harder than it needed to be.",
    "so I started looking for another role soon after.",
    "and honestly it was the best change in years.",
    "though some colleagues disagreed strongly with me.",
    "leaving us to figure out the details alone for weeks.",
  ];
  const lines = ["id,dept,tenure,response"];
  const depts = ["sales", "eng", "support", "hr"];
  for (let i = 0; i < 10000; i++) {
    let resp = `${subjects[randInt(rand, 6)]} ${verbs[randInt(rand, 6)]} ${objects[randInt(rand, 6)]} ${tails[randInt(rand, 6)]}`;
    if (rand() < 0.4) resp += ` ${subjects[randInt(rand, 6)]} ${verbs[randInt(rand, 6)]} ${objects[randInt(rand, 6)]} ${tails[randInt(rand, 6)]}`;
    lines.push(`e${i},${depts[randInt(rand, 4)]},${1 + randInt(rand, 20)},"${resp}"`);
  }
  writeFileSync(p, lines.join("\n") + "\n");

  const t0 = performance.now();
  const parsed = await csv.parse(p);
  const det = mapping.detect(parsed.rows);
  const textCol = det.columns.find((c) => c.role === "text");
  const units = unitize("c_perf", parsed, "response", { textColumn: textCol.name });
  const res = junk.scan(units);
  const ms = performance.now() - t0;

  assert.equal(parsed.rows.length, 10000);
  assert.equal(textCol.name, "response");
  assert.equal(units.length, 10000);
  assert.ok(res.counts, "junk scan ran");
  assert.ok(ms < 10000, `pipeline took ${ms.toFixed(0)}ms`);
  console.log(`perf: 10k-row pipeline took ${ms.toFixed(0)}ms`);
  rmSync(dir, { recursive: true, force: true });
});
