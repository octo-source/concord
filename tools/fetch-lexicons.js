// Fetch bundleable lexicons. Run once: node tools/fetch-lexicons.js
//
// Downloads the VADER sentiment lexicon (MIT license) from the canonical
// vaderSentiment repository and writes server/lexicons/vader.json as
//   { name: "VADER", license: "MIT", source, fetched, terms: {<term>: <valence>} }
//
// vader_lexicon.txt format: token<TAB>mean valence<TAB>stddev<TAB>raw ratings.
// We keep token → mean valence. Emoticon entries (":)", "</3", "$:", …) are
// DROPPED: they contain no word characters, so Concord's tokenizer can never
// produce them and compile() rejects them as unmatchable. The drop count is
// recorded in the JSON header for transparency.
//
// NRC EmoLex and LIWC are deliberately NOT fetched or bundled — their licenses
// do not permit redistribution. Use importTsvLexicon()/parseDic() at runtime
// instead. See server/lexicons/LICENSES.md.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tokenize } from "../server/instruments/dictionary.js";

const VADER_URL =
  "https://raw.githubusercontent.com/cjhutto/vaderSentiment/master/vaderSentiment/vader_lexicon.txt";
const OUT_DIR = fileURLToPath(new URL("../server/lexicons/", import.meta.url));

async function main() {
  console.log(`Fetching VADER lexicon from ${VADER_URL} ...`);
  const res = await fetch(VADER_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();

  const terms = {};
  let skipped = 0;
  let droppedNonWord = 0;
  let droppedMisplacedStar = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const cols = line.split("\t");
    const term = cols[0];
    const valence = Number(cols[1]);
    if (!term || Number.isNaN(valence)) {
      skipped++;
      continue;
    }
    if (tokenize(term).length === 0) {
      droppedNonWord++; // emoticons etc. — unmatchable by the word tokenizer
      continue;
    }
    const star = term.indexOf("*");
    if (star !== -1 && star !== term.length - 1) {
      droppedMisplacedStar++; // engine reserves * for trailing wildcards (upstream has "*\0/*")
      continue;
    }
    terms[term] = valence;
  }
  const count = Object.keys(terms).length;
  if (count < 5000) {
    throw new Error(`parsed only ${count} terms — file format changed? aborting`);
  }

  const out = {
    name: "VADER",
    license: "MIT",
    source: VADER_URL,
    attribution:
      "Hutto, C.J. & Gilbert, E.E. (2014). VADER: A Parsimonious Rule-based Model for Sentiment Analysis of Social Media Text. ICWSM-14.",
    fetched: new Date().toISOString().slice(0, 10),
    droppedNonWord,
    droppedMisplacedStar,
    note:
      `${droppedNonWord} emoticon/symbol entries from the upstream lexicon were dropped: they contain no word ` +
      `characters, so Concord's tokenizer can never match them. ${droppedMisplacedStar} entries with a ` +
      `non-trailing * were dropped (the engine reserves * for trailing wildcards).`,
    terms,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_DIR + "vader.json", JSON.stringify(out, null, 1) + "\n", "utf8");
  console.log(
    `Wrote server/lexicons/vader.json: ${count} terms (${skipped} malformed lines skipped, ${droppedNonWord} non-word entries dropped).`,
  );
}

main().catch((err) => {
  console.error(`VADER fetch FAILED: ${err.message}`);
  console.error(
    "No file written. Either re-run with network access, or author a clearly-labeled" +
      ' fallback subset: {name: "VADER-mini (subset)", note: "fetch failed; starter subset", ...}.',
  );
  process.exit(1);
});
