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
  assert.deepEqual(rows, [
    { a: "1", b: "x y" },
    { a: "2", b: "z" },
  ]);
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

test("csv: header dedup never collides with a real later column", async () => {
  const dir = tempDir();
  const p = join(dir, "dup2.csv");
  writeFileSync(p, "x,x,x_2\n1,2,3\n");
  const { rows, issues } = await csv.parse(p);
  const keys = Object.keys(rows[0]);
  assert.equal(keys.length, 3, `keys: ${keys.join(",")}`);
  assert.equal(new Set(keys).size, 3, "all column names distinct");
  // all three values survive: the synthesized name for the second "x" must
  // not steal the real "x_2" column's name
  assert.equal(rows[0].x, "1");
  assert.equal(rows[0].x_3, "2");
  assert.equal(rows[0].x_2, "3");
  assert.ok(issues.some((i) => i.kind === "dup_header"));
  rmSync(dir, { recursive: true, force: true });
});

test("csv: stray quote mid-field kept literal", async () => {
  const dir = tempDir();
  const p = join(dir, "stray.csv");
  writeFileSync(p, 'a,b\n1,ab"cd\n');
  const { rows } = await csv.parse(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].b, 'ab"cd');
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

test("pdf: text items without a transform array are filtered, not fatal", () => {
  const mk = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y], height: 12 });
  const items = [
    mk("Hello", 72, 720),
    { str: "ghost-no-transform" },
    { str: "bad-transform", transform: null },
    mk("world", 110, 720),
  ];
  const paras = pdf.pageParagraphs(items);
  assert.deepEqual(paras, ["Hello world"]);
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

test("text: malformed numeric entity survives as literal, no throw", () => {
  const paras = text.htmlToParas("<p>bad &#x110000; entity &amp; ok &#xD83D; lone</p>");
  assert.equal(paras.length, 1);
  assert.ok(paras[0].includes("&#x110000;"), `out-of-range entity kept literal, got: ${paras[0]}`);
  assert.ok(paras[0].includes("& ok"), "amp still decodes");
});

test("text: named entities mdash/ndash/quotes/hellip decode", () => {
  const paras = text.htmlToParas(
    "<p>em&mdash;dash en&ndash;dash &lsquo;l&rsquo; &ldquo;d&rdquo; wait&hellip; it&apos;s</p>",
  );
  assert.equal(paras[0], "em—dash en–dash ‘l’ “d” wait… it's");
});

// =============================================================== transcript.js

test("vtt: hour timestamps parsed; same-speaker cues an hour apart do NOT merge", async () => {
  const { turns } = await transcript.parse(fix("ingest-sample.vtt"));
  // Alice's second cue starts >1h after her first ends: that is a new turn.
  // (Merging across arbitrary gaps was the old behavior — and the bug.)
  assert.equal(turns.length, 3);
  assert.equal(turns[0].speaker, "Alice");
  assert.equal(turns[0].text, "Hello everyone.");
  assert.equal(turns[0].t0, 1);
  assert.equal(turns[0].t1, 4);
  assert.equal(turns[1].speaker, "Alice");
  assert.equal(turns[1].text, "Welcome to the meeting.");
  assert.equal(turns[1].t0, 1 * 3600 + 2 * 60 + 3.5);
  assert.equal(turns[1].t1, 1 * 3600 + 2 * 60 + 6);
  assert.equal(turns[2].speaker, "Bob");
  assert.equal(turns[2].t0, 1 * 3600 + 2 * 60 + 7);
  assert.equal(turns[2].t1, 1 * 3600 + 2 * 60 + 9.25);
});

test("vtt: maxMergeGapSeconds option re-enables cross-gap merging", async () => {
  const { turns } = await transcript.parse(fix("ingest-sample.vtt"), { maxMergeGapSeconds: 7200 });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, "Hello everyone. Welcome to the meeting.");
  assert.equal(turns[0].t1, 1 * 3600 + 2 * 60 + 6);
});

test("transcript: consecutive anonymous cues stay separate turns", async () => {
  // Pin: speaker-less captions are often arbitrary mid-sentence breaks; a
  // refactor must not silently fuse the whole file into one turn.
  const dir = tempDir();
  const p = join(dir, "anon.vtt");
  writeFileSync(
    p,
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfirst anonymous line\n\n00:00:02.500 --> 00:00:03.500\nsecond anonymous line\n",
  );
  const { turns } = await transcript.parse(p);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, "Speaker");
  assert.equal(turns[0].text, "first anonymous line");
  assert.equal(turns[1].text, "second anonymous line");
  rmSync(dir, { recursive: true, force: true });
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

test("zoom json: Otter/Rev words arrays join into text, not [object Object]", () => {
  const raw = JSON.stringify({
    segments: [
      {
        speaker: "Eve",
        start: 0,
        end: 2.5,
        words: [{ text: "Deep" }, { word: "work" }, "matters", { text: "here" }],
      },
      { speaker: "Frank", start: 3, end: 5, words: [{ text: "Agreed" }, { word: "fully" }] },
    ],
  });
  const issues = [];
  const cues = transcript.parseZoomJSON(raw, issues);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "Deep work matters here");
  assert.equal(cues[1].text, "Agreed fully");
  assert.ok(!cues.some((c) => c.text.includes("[object Object]")));
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
    const units = unitize(CORPUS, { rows: [{ t: textIn }], issues: [] }, "sentence", {
      textColumn: "t",
    });
    assert.equal(
      units.length,
      n,
      `"${textIn}" -> expected ${n}, got ${units.map((u) => JSON.stringify(u.text))}`,
    );
  }
});

test("unitize sentence: Unicode capitals (Ž, Cyrillic, Ý) open sentences; × does not", () => {
  const cases = [
    ["Okay. Žižek wrote it.", 2],
    ["Да. Хорошо тогда.", 2],
    ["Stop. Ýmir came home.", 2],
    ["Three by five. × is the times sign.", 1], // × (U+00D7) is not a capital letter
    ["lower case start. no split here.", 1], // lowercase sentence starts intentionally do not split
  ];
  for (const [textIn, n] of cases) {
    const units = unitize(CORPUS, { rows: [{ t: textIn }], issues: [] }, "sentence", {
      textColumn: "t",
    });
    assert.equal(units.length, n, `"${textIn}" -> got ${JSON.stringify(units.map((u) => u.text))}`);
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

test("unitize turn: id uses SOURCE turn index even after skipped empty turns", () => {
  const skipped = {
    turns: [
      { speaker: "A", t0: 0, t1: 2, text: "First turn." },
      { speaker: "B", t0: 2, t1: 4, text: "   " },
      { speaker: "C", t0: 4, t1: 6, text: "Third turn here." },
    ],
    issues: [],
  };
  const units = unitize(CORPUS, skipped, "turn");
  assert.equal(units.length, 2);
  assert.equal(units[1].pos.turn, 2);
  assert.equal(units[1].id, unitId(CORPUS, 2, "Third turn here."));
  // same turn keeps the same id when the empty middle turn has text instead
  const filled = {
    turns: [
      { speaker: "A", t0: 0, t1: 2, text: "First turn." },
      { speaker: "B", t0: 2, t1: 4, text: "Middle turn present." },
      { speaker: "C", t0: 4, t1: 6, text: "Third turn here." },
    ],
    issues: [],
  };
  const filledUnits = unitize(CORPUS, filled, "turn");
  assert.equal(filledUnits[2].id, units[1].id);
});

test("unitize paragraph: id uses SOURCE doc/para indices even after skipped empty paras", () => {
  const skipped = {
    docs: [
      { name: "a.txt", paras: ["Para one.", "   ", "Para three."] },
      { name: "b.txt", paras: ["Other doc."] },
    ],
    issues: [],
  };
  const units = unitize(CORPUS, skipped, "paragraph");
  assert.equal(units.length, 3);
  assert.deepEqual(units[1].pos, { doc: "a.txt", para: 2 });
  assert.equal(units[1].id, unitId(CORPUS, "0:2", "Para three."));
  assert.equal(units[2].id, unitId(CORPUS, "1:0", "Other doc."));
  // same paras keep the same ids when the empty para has text instead
  const filled = {
    docs: [
      { name: "a.txt", paras: ["Para one.", "Middle para present.", "Para three."] },
      { name: "b.txt", paras: ["Other doc."] },
    ],
    issues: [],
  };
  const filledUnits = unitize(CORPUS, filled, "paragraph");
  assert.equal(filledUnits.length, 4);
  assert.equal(filledUnits[2].id, units[1].id);
  assert.equal(filledUnits[3].id, units[2].id);
});

test("unitize sentence: identical sentences in different rows get distinct ids", () => {
  const parsed = { rows: [{ t: "Yes I agree." }, { t: "Yes I agree." }], issues: [] };
  const units = unitize(CORPUS, parsed, "sentence", { textColumn: "t" });
  assert.equal(units.length, 2);
  assert.notEqual(units[0].id, units[1].id);
});

test("unitize sentence: ids anchored to source row, unchanged when earlier empty row gains text", () => {
  const skipped = { rows: [{ t: "" }, { t: "Stable point. Another point." }], issues: [] };
  const filled = {
    rows: [{ t: "New text appeared. Two sentences now." }, { t: "Stable point. Another point." }],
    issues: [],
  };
  const a = unitize(CORPUS, skipped, "sentence", { textColumn: "t" });
  const b = unitize(CORPUS, filled, "sentence", { textColumn: "t" });
  assert.equal(a.length, 2);
  assert.equal(b.length, 4);
  // row 1's sentence ids do not depend on whether row 0 was empty
  assert.deepEqual(
    a.map((u) => u.id),
    b.slice(2).map((u) => u.id),
  );
  // id = unitId(corpusId, "<sourceRowIndex>:<sentenceIndexWithinRow>", text)
  assert.equal(a[0].id, unitId(CORPUS, "1:0", "Stable point."));
  assert.equal(a[1].id, unitId(CORPUS, "1:1", "Another point."));
});

test("unitize: re-running on identical parsed input yields identical ids (all schemes)", () => {
  const rows = {
    rows: [{ t: "One thing. Two things." }, { t: "" }, { t: "Three things." }],
    issues: [],
  };
  const docs = { docs: [{ name: "a.txt", paras: ["P one.", "", "P two."] }], issues: [] };
  const turns = {
    turns: [
      { speaker: "A", t0: 0, t1: 1, text: "Hi there. Quick note." },
      { speaker: "B", t0: 1, t1: 2, text: "" },
      { speaker: "C", t0: 2, t1: 3, text: "Bye now." },
    ],
    issues: [],
  };
  const runs = [
    ["response", rows, { textColumn: "t" }],
    ["sentence", rows, { textColumn: "t" }],
    ["paragraph", docs, {}],
    ["sentence", docs, {}],
    ["turn", turns, {}],
    ["sentence", turns, {}],
  ];
  for (const [scheme, parsed, opts] of runs) {
    const ids1 = unitize(CORPUS, parsed, scheme, opts).map((u) => u.id);
    const ids2 = unitize(CORPUS, parsed, scheme, opts).map((u) => u.id);
    assert.ok(ids1.length > 0, `${scheme}: expected units`);
    assert.deepEqual(ids1, ids2, `${scheme}: ids differ across identical runs`);
    assert.equal(new Set(ids1).size, ids1.length, `${scheme}: ids not unique`);
  }
});

test("unitize: scheme/source mismatch throws ConcordError", () => {
  assert.throws(
    () => unitize(CORPUS, { rows: [{ t: "x" }], issues: [] }, "turn", { textColumn: "t" }),
    (e) => e.name === "ConcordError" && e.code === "BAD_SCHEME",
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

test("junk: keyboard mash means row runs or repeats, not any row-letter word", () => {
  for (const t of ["asdf", "asdfasdf", "qwerty", "zxcv", "qwert", "jkl", "xxxx", "sdfg", "poiuy"]) {
    assert.equal(junk.isKeyboardMash(t), true, `"${t}" should be flagged as mash`);
  }
  // real words spelled entirely from home/top-row letters are NOT mash
  for (const t of ["true", "power", "quiet", "all", "sad", "were", "salad", "yes", "ok sure"]) {
    assert.equal(junk.isKeyboardMash(t), false, `"${t}" should NOT be flagged as mash`);
  }
});

test("junk: bare 'no' and 'nope' are substantive answers, not NA", () => {
  assert.equal(junk.isNa("no"), false);
  assert.equal(junk.isNa("No."), false);
  assert.equal(junk.isNa("nope"), false);
  // none/nothing/na variants remain NA
  for (const t of ["none", "nothing", "n/a", "NA", "n.a.", "none."]) {
    assert.equal(junk.isNa(t), true, `"${t}" should remain NA`);
  }
});

test("junk: scan does not flag 'no'/'nope'/row-letter words as na", () => {
  const units = mkUnits(["no", "nope", "true", "power", "quiet all sad"]);
  const { flagged, counts } = junk.scan(units);
  assert.equal(counts.na, 0, JSON.stringify(flagged));
});

test("junk: short flag when corpus median is long", () => {
  const long = Array.from(
    { length: 8 },
    (_, i) => `A long enough answer number ${i} with many words.`,
  );
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
  const units = mkUnits([
    t,
    t,
    "yes",
    "yes",
    "yes",
    "A unique long answer with lots of words inside.",
  ]);
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
  // the credentialed URL contains "pw@internal.example.org", which also matches
  // the email regex — the longer url_user span must suppress that email span
  assert.ok(!kinds(units[3]).includes("email"), "embedded email span suppressed by url_user");
  const urlSpan = byId[units[3].id].find((s) => s.kind === "url_user");
  assert.equal(
    units[3].text.slice(urlSpan.start, urlSpan.end),
    "https://user:pw@internal.example.org/path",
  );
  assert.ok(kinds(units[4]).includes("phone"));
  assert.equal(byId[units[5].id], undefined);
});

test("pii: dates and year lists are not masked as phones", () => {
  const units = mkPiiUnits([
    "Project kicked off 2024-01-15 with the team.",
    "Deadline moved to 10.04.2022 after review.",
    "We compared 2022 2023 2024 results side by side.",
    "Slash date 1/15/2024 also appears.",
  ]);
  const { findings, counts } = pii.scan(units);
  assert.equal(counts.phone, 0, `dates flagged as phones: ${JSON.stringify(findings)}`);
});

test("pii: real phone formats still detected", () => {
  const units = mkPiiUnits([
    "Call 555-867-5309 today.",
    "Or (555) 867-5309 works.",
    "Maybe 555.867.5309 instead.",
    "London office +44 20 7946 0958 line.",
    "US desk +1-202-555-0143 anytime.",
    "Bare intl +14155550123 mobile.",
  ]);
  const { findings, counts } = pii.scan(units);
  assert.equal(counts.phone, 6, JSON.stringify(findings.map((f) => f.spans)));
  const texts = findings
    .flatMap((f) => f.spans)
    .filter((s) => s.kind === "phone")
    .map((s) => s.text);
  assert.ok(
    texts.includes("(555) 867-5309"),
    `parens format detected, got ${JSON.stringify(texts)}`,
  );
  assert.ok(texts.includes("+44 20 7946 0958"));
});

test("pii: spans slice exactly with astral chars (emoji) before the match", () => {
  const t = "🎉🎉 reach jane@x.org or 555-867-5309 now";
  const spans = pii.scanText(t);
  const email = spans.find((s) => s.kind === "email");
  assert.ok(email, "email found after emoji");
  assert.equal(t.slice(email.start, email.end), "jane@x.org");
  const phone = spans.find((s) => s.kind === "phone");
  assert.ok(phone, "phone found after emoji");
  assert.equal(t.slice(phone.start, phone.end), "555-867-5309");
});

test("pii: accented names detected, masked, and restored exactly", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  const original = "Hablé con José García ayer.";
  const spans = pii.scanText(original);
  const name = spans.find((s) => s.kind === "name");
  assert.ok(name, `name span found, got ${JSON.stringify(spans)}`);
  assert.equal(original.slice(name.start, name.end), "José García");

  const units = mkPiiUnits([original]);
  const { units: masked } = await pii.pseudonymize(units, vaultPath);
  assert.ok(masked[0].text.includes("[NAME_1]"), `got: ${masked[0].text}`);
  assert.ok(!masked[0].text.includes("José"));
  const restored = await pii.reidentify(masked, vaultPath);
  assert.equal(restored[0].text, original);
  rmSync(dir, { recursive: true, force: true });
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
  assert.deepEqual(
    restored.map((u) => u.text),
    originals,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("pii: second batch accumulates into the vault — distinct tokens, both reidentify", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  const batch1 = mkPiiUnits(["Email alpha@one.com about the audit."]);
  const { units: m1 } = await pii.pseudonymize(batch1, vaultPath);
  assert.ok(m1[0].text.includes("[EMAIL_1]"));

  const batch2 = mkPiiUnits(["Email beta@two.com and alpha@one.com again."]);
  const { units: m2 } = await pii.pseudonymize(batch2, vaultPath);
  // the NEW address continues numbering; it must NOT reuse [EMAIL_1]
  assert.ok(m2[0].text.includes("[EMAIL_2]"), `got: ${m2[0].text}`);
  // the repeated address reuses its batch-1 token
  assert.ok(m2[0].text.includes("[EMAIL_1]"), `got: ${m2[0].text}`);

  const v = JSON.parse(readFileSync(vaultPath, "utf8"));
  assert.equal(v.tokens["[EMAIL_1]"], "alpha@one.com");
  assert.equal(v.tokens["[EMAIL_2]"], "beta@two.com");

  // both batches reidentify correctly against the shared vault
  const r1 = await pii.reidentify(m1, vaultPath);
  assert.equal(r1[0].text, "Email alpha@one.com about the audit.");
  const r2 = await pii.reidentify(m2, vaultPath);
  assert.equal(r2[0].text, "Email beta@two.com and alpha@one.com again.");
  rmSync(dir, { recursive: true, force: true });
});

test("pii: pseudonymize re-run on already-masked text is a no-op", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  const units = mkPiiUnits(["Reach jane.doe@example.com or 555-867-5309 soon."]);
  const { units: masked } = await pii.pseudonymize(units, vaultPath);
  assert.ok(
    masked[0].text.includes("[EMAIL_1]") && masked[0].text.includes("[PHONE_1]"),
    masked[0].text,
  );
  const vaultBefore = JSON.parse(readFileSync(vaultPath, "utf8"));

  const { units: again } = await pii.pseudonymize(masked, vaultPath);
  assert.equal(again[0].text, masked[0].text, "re-masking already-masked text must not change it");
  const vaultAfter = JSON.parse(readFileSync(vaultPath, "utf8"));
  assert.deepEqual(vaultAfter.tokens, vaultBefore.tokens, "vault tokens must survive a re-run");
  // originals are still recoverable
  const restored = await pii.reidentify(again, vaultPath);
  assert.equal(restored[0].text, "Reach jane.doe@example.com or 555-867-5309 soon.");
  rmSync(dir, { recursive: true, force: true });
});

test("pii: pseudonymize refuses to remap an existing token (VAULT_CONFLICT)", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  await pii.pseudonymize(mkPiiUnits(["First mail alpha@one.com here."]), vaultPath);
  // This text carries [EMAIL_2], which the vault does NOT define — proceeding
  // would let the next minted email token alias it to a different original.
  const tainted = mkPiiUnits(["Old export said [EMAIL_2] but new mail is beta@two.com."]);
  await assert.rejects(
    () => pii.pseudonymize(tainted, vaultPath),
    (e) => e.name === "ConcordError" && e.code === "VAULT_CONFLICT",
  );
  // the failed run must not have damaged the existing vault
  const v = JSON.parse(readFileSync(vaultPath, "utf8"));
  assert.deepEqual(v.tokens, { "[EMAIL_1]": "alpha@one.com" });
  rmSync(dir, { recursive: true, force: true });
});

test("pii: scan on clean units returns empty findings", () => {
  const { findings, counts } = pii.scan(mkPiiUnits(["just a plain sentence about work."]));
  assert.deepEqual(findings, []);
  assert.equal(
    Object.values(counts).reduce((a, b) => a + b, 0),
    0,
  );
});

// Identifiers do not only live in unit text: survey exports carry emails and
// phone numbers in METADATA columns (respondent contact fields), and those
// values ride into the replication archive's units CSV and into Director
// prompts (renderUnit shows meta k=v). scan and pseudonymize must treat every
// string metadata value as first-class scannable text — same counts, same
// vault, same [KIND_n] token format.

test("pii: scan covers metadata column values — counts, flags, per-column findings", () => {
  const units = mkPiiUnits([
    "the portal stayed broken for everyone on the team.", // clean text
    "escalate to dispatch at 555-867-5309 if it recurs.", // phone in text
  ]);
  units[0].meta = { contact: "jane.doe@example.com", dept: "ops", age: 41 };
  units[1].meta = { backup: "bob@test.org", note: null };

  const { findings, counts } = pii.scan(units);
  assert.equal(counts.email, 2, `meta emails counted: ${JSON.stringify(counts)}`);
  assert.equal(counts.phone, 1);

  // clean text + dirty meta: the unit is still flagged, the finding names the column
  assert.ok(
    units[0].flags?.pii?.includes("email"),
    `unit 0 flags: ${JSON.stringify(units[0].flags)}`,
  );
  const f0 = findings.find((f) => f.unitId === units[0].id);
  assert.ok(f0, "finding exists for a unit whose only PII is in metadata");
  assert.deepEqual(f0.spans, [], "no text spans on a clean-text unit");
  assert.equal(f0.meta?.length, 1, `meta findings: ${JSON.stringify(f0.meta)}`);
  assert.equal(f0.meta[0].column, "contact");
  assert.equal(f0.meta[0].spans[0].kind, "email");
  assert.equal(f0.meta[0].spans[0].text, "jane.doe@example.com");

  // text phone + meta email union into the unit's flags
  assert.deepEqual([...units[1].flags.pii].sort(), ["email", "phone"]);
});

test("pii: pseudonymize masks metadata values — same vault, shared tokens, types preserved, roundtrip", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  const units = mkPiiUnits([
    "wrote to jane.doe@example.com about the rota.",
    "no identifiers in this text at all.",
  ]);
  units[0].meta = { contact: "jane.doe@example.com", dept: "ops", rows: 12 };
  units[1].meta = { contact: "bob@test.org", phone: "555-867-5309" };
  const originalMeta = units.map((u) => ({ ...u.meta }));

  const { units: masked, vault } = await pii.pseudonymize(units, vaultPath);

  // the same address in text and meta shares ONE token
  assert.ok(masked[0].text.includes("[EMAIL_1]"), masked[0].text);
  assert.equal(masked[0].meta.contact, "[EMAIL_1]");
  // meta-only identifiers get their own tokens — same format, same vault
  assert.equal(masked[1].meta.contact, "[EMAIL_2]");
  assert.equal(masked[1].meta.phone, "[PHONE_1]");
  // untouched values ride along with their types intact
  assert.equal(masked[0].meta.dept, "ops");
  assert.equal(masked[0].meta.rows, 12);
  // a unit whose only PII sat in metadata is still flagged
  assert.ok(masked[1].flags?.pii?.includes("email"));
  assert.ok(masked[1].flags?.pii?.includes("phone"));
  // the input units (and their meta objects) are never mutated
  assert.deepEqual(
    units.map((u) => u.meta),
    originalMeta,
  );
  assert.equal(units[0].meta.contact, "jane.doe@example.com");
  // batch counts include the meta occurrences
  assert.equal(vault.counts.email, 3, JSON.stringify(vault.counts));
  assert.equal(vault.counts.phone, 1);
  // one vault holds every mapping
  const v = JSON.parse(readFileSync(vaultPath, "utf8"));
  assert.equal(v.tokens["[EMAIL_1]"], "jane.doe@example.com");
  assert.equal(v.tokens["[EMAIL_2]"], "bob@test.org");
  assert.equal(v.tokens["[PHONE_1]"], "555-867-5309");

  // reidentify restores text AND metadata exactly
  const restored = await pii.reidentify(masked, vaultPath);
  assert.equal(restored[0].text, "wrote to jane.doe@example.com about the rota.");
  assert.deepEqual(
    restored.map((u) => u.meta),
    originalMeta,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("pii: pseudonymize re-run over masked metadata is a no-op", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  const units = mkPiiUnits(["plain text here."]);
  units[0].meta = { contact: "jane.doe@example.com" };
  const { units: masked } = await pii.pseudonymize(units, vaultPath);
  assert.equal(masked[0].meta.contact, "[EMAIL_1]");
  const vaultBefore = JSON.parse(readFileSync(vaultPath, "utf8"));

  const { units: again } = await pii.pseudonymize(masked, vaultPath);
  assert.equal(
    again[0].meta.contact,
    "[EMAIL_1]",
    "vault-known token in a meta value is protected",
  );
  const vaultAfter = JSON.parse(readFileSync(vaultPath, "utf8"));
  assert.deepEqual(
    vaultAfter.tokens,
    vaultBefore.tokens,
    "vault tokens must survive a meta re-run",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("pii: unknown pseudonym token in a metadata value → VAULT_CONFLICT, vault untouched", async () => {
  const dir = tempDir();
  const vaultPath = join(dir, "vault.json");
  await pii.pseudonymize(mkPiiUnits(["First mail alpha@one.com here."]), vaultPath);
  // [EMAIL_9] is token-shaped but not in this vault: it was masked against
  // some OTHER vault, and minting over it would corrupt re-identification.
  const tainted = mkPiiUnits(["clean text."]);
  tainted[0].meta = { contact: "[EMAIL_9]" };
  await assert.rejects(
    () => pii.pseudonymize(tainted, vaultPath),
    (e) => e.name === "ConcordError" && e.code === "VAULT_CONFLICT",
  );
  const v = JSON.parse(readFileSync(vaultPath, "utf8"));
  assert.deepEqual(v.tokens, { "[EMAIL_1]": "alpha@one.com" });
  rmSync(dir, { recursive: true, force: true });
});

// =============================================================== perf

test("perf: 10k-row CSV full pipeline < 10s", async () => {
  const dir = tempDir();
  const p = join(dir, "big.csv");
  const rand = mulberry32(42);
  const subjects = [
    "The manager",
    "My team",
    "Senior leadership",
    "The new policy",
    "Our schedule",
    "The pay structure",
  ];
  const verbs = ["ignored", "improved", "ruined", "supported", "changed", "complicated"];
  const objects = [
    "our morale",
    "the workload",
    "every deadline",
    "my growth path",
    "the review process",
    "team flexibility",
  ];
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
    if (rand() < 0.4)
      resp += ` ${subjects[randInt(rand, 6)]} ${verbs[randInt(rand, 6)]} ${objects[randInt(rand, 6)]} ${tails[randInt(rand, 6)]}`;
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
