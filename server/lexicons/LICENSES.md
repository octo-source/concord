# Lexicon licenses

Every lexicon bundled in this directory is redistributable. Lexicons whose
licenses do not permit redistribution are **import-not-bundle**: Concord ships
the importers, you bring the file. License labels are surfaced in the UI
wherever a lexicon is offered.

## Bundled

### vader.json — VADER sentiment lexicon (MIT)

- Source: <https://github.com/cjhutto/vaderSentiment>
  (`vaderSentiment/vader_lexicon.txt`), fetched by `tools/fetch-lexicons.js`.
- Attribution: Hutto, C.J. & Gilbert, E.E. (2014). *VADER: A Parsimonious
  Rule-based Model for Sentiment Analysis of Social Media Text.* Eighth
  International Conference on Weblogs and Social Media (ICWSM-14).
- Modification: emoticon/symbol entries containing no word characters were
  dropped at fetch time (count recorded in the file header) because Concord's
  word tokenizer can never match them.

MIT License

Copyright (c) 2016 C.J. Hutto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### starter-emotions.json, starter-moral.json, starter-work.json (CC0)

Original Concord starter lexicons, authored for this project and dedicated to
the public domain under CC0 1.0 Universal
(<https://creativecommons.org/publicdomain/zero/1.0/>). Term lists were
written from scratch in a workplace-survey register; the category *names*
follow standard conventions (Plutchik's eight emotions; moral-foundations
labels), but the term lists are not copied from NRC EmoLex, the Moral
Foundations Dictionary, LIWC, or any other licensed instrument. Use, modify,
and redistribute freely, no attribution required.

## Import-not-bundle

### NRC Emotion Lexicon (EmoLex)

The NRC Word-Emotion Association Lexicon (Mohammad & Turney) is free for
research but its terms of use do **not** permit redistribution, so Concord
does not bundle it. If you have obtained EmoLex from
<https://saifmohammad.com/WebPages/NRC-Emotion-Lexicon.htm>, import its TSV
distribution (`word<TAB>emotion<TAB>association`) with:

    importTsvLexicon(text, { termCol: 0, categoryCol: 1, valueCol: 2 })

from `server/instruments/dictionary.js`. Rows with association `0` are
skipped; the result is a standard DictionaryPayload.

### LIWC

LIWC dictionaries (Pennebaker et al.) are commercial and licensed per seat;
Concord does not and cannot bundle them. License holders can import their
`.dic` file with `parseDic(text)` from `server/instruments/dictionary.js`
(wildcards preserved, percent-of-words scoring matches the LIWC convention),
and export edited payloads back to `.dic` with `toDic(payload)`. `parseDic`
returns `{ payload, warnings }`, not a bare payload: LIWC 2007/2015
conditional entries (e.g. `like<TAB>(2 134)2/96`) are skipped and reported in
`warnings` rather than failing the import.
