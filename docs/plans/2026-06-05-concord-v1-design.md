# Concord v1 — Technical Design

**Date:** 2026-06-05
**Source spec:** Product Specification v0.2 (single full-scope release)
**Decision:** Local Node.js app. Server + browser UI, zero native dependencies, runnable by double-clicking `start.bat`.

This document translates the v0.2 spec into a buildable system. It records every deviation from the spec and fixes the contracts (object model, on-disk formats, module boundaries, API surface) that parallel workstreams build against.

---

## 1. Form factor

- **Runtime:** Node 22 (verified on target machine: v22.14.0). ES modules throughout. No build step — the browser loads ES modules directly.
- **Server:** Node `http` with a small hand-rolled router. No framework.
- **UI:** Vanilla JS single-page app served from `app/`. Hand-rolled SVG charts. SSE for streaming (Brief, run monitor, tuning loop).
- **Dependencies (all pure JS):** `xlsx` (SheetJS), `mammoth` (DOCX), `pdfjs-dist` legacy build (PDF text), `busboy` (multipart), `fflate` (zip for replication archives). Nothing that compiles.
- **Launch:** `start.bat` → `npm install` on first run → `node server/index.js` → opens `http://localhost:7341`.

## 2. Deviations from spec §9

| Spec                       | v1                                                                                                    | Spec intent preserved by                                                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tauri + Rust core          | Node server + browser                                                                                 | Local-first, data residency, offline dictionaries all hold. UI is web tech either way; Tauri later wraps this app.                                                                                                                                 |
| SQLite + DuckDB            | NDJSON/JSON project bundles                                                                           | Single portable folder per project; append-only ledger; crash consistency via atomic temp-file renames. Honest limit: fluid to ~100k units, not 1M.                                                                                                |
| OS keychain                | `config/keys.json`, gitignored, outside project bundles                                               | Keys never enter project files or replication archives.                                                                                                                                                                                            |
| E2E-encrypted relay        | Shared-drive sync (bundles are plain folders) + Coder launch profile                                  | Spec allows shared drive. Coder role enforces blindness by serving only the coding screen and masking machine/other-coder labels server-side.                                                                                                      |
| Local Whisper              | Transcript import only (VTT/SRT/JSON)                                                                 | Strict mode still ingests transcripts; audio transcription can attach later via any local OpenAI-compatible endpoint.                                                                                                                              |
| Embedded Python statistics | Pure-JS statistics engine                                                                             | Validated against hand-derived golden numbers and by simulation (see §10). Replication packages emit R/Python that reproduces every number outside Concord — that code targets the reference `dsl` package, preserving the auditability guarantee. |
| Local embedding models     | Ollama embeddings when available; otherwise Director-suggested expansion + character-ngram similarity | Dictionary expansion degrades gracefully; the product states which method produced suggestions.                                                                                                                                                    |

Everything else in the spec ships as written.

## 3. Repository layout

```
concord/
├── start.bat
├── package.json              # type: module
├── server/
│   ├── index.js              # http server, static files, router, SSE
│   ├── router.js
│   ├── routes/               # one module per API domain
│   ├── core/
│   │   ├── store.js          # project bundles: load/save, atomic writes, locks
│   │   ├── ledger.js         # append-only hash-chained provenance ledger
│   │   ├── objects.js        # the 8 objects: create, validate, version, freeze
│   │   ├── ids.js            # ulid-style ids, content hashes (sha256)
│   │   └── cache.js          # content-addressed response cache
│   ├── ingest/               # csv.js, xlsx.js, docx.js, pdf.js, text.js, transcript.js,
│   │                         # mapping.js (column detection), unitize.js, junk.js, pii.js
│   ├── instruments/
│   │   ├── dictionary.js     # scoring, .dic import, builder, negation windows
│   │   ├── judge.js          # prompt assembly, schema enforcement, rationale-first
│   │   ├── panel.js          # aggregation rules, entropy, juror cross-tabs
│   │   └── stability.js      # k-run test–retest → ◑
│   ├── providers/
│   │   ├── base.js           # adapter contract, pooling, backoff, batching
│   │   ├── anthropic.js, openai.js, openrouter.js, ollama.js, mock.js
│   │   ├── registry.js       # model catalog, snapshot pinning, privacy enforcement
│   │   └── costs.js          # metering, pre-flight estimates, budget caps
│   ├── director/
│   │   ├── director.js       # Director session: model selection, cost metering
│   │   ├── brief.js          # Corpus Brief (stratified sample → streamed memo)
│   │   ├── constructs.js     # drafting, legacy codebook import, inductive mode
│   │   ├── compiler.js       # instrument compilation targeted to worker class
│   │   ├── silver.js         # silver labels + auto prompt-tuning loop
│   │   ├── panels.js         # panel architecture recommendation
│   │   ├── escalate.js       # escalation second opinions
│   │   ├── analyst.js        # post-run analysis suggestions
│   │   └── questionbar.js    # plain-language question → visible plan
│   ├── runs/
│   │   ├── engine.js         # checkpointed async execution, quarantine, resume
│   │   └── monitor.js        # live state, degenerate-output warning, drift tripwire
│   ├── stats/
│   │   ├── agreement.js      # percent, Cohen's κ, Krippendorff's α (nom/ord/int),
│   │   │                     # Gwet's AC1, per-class P/R/F1, confusion matrices
│   │   ├── boot.js           # bootstrap CIs, McNemar, TOST equivalence
│   │   ├── correction.js     # DSL doubly-robust estimators + PPI, sandwich SEs
│   │   ├── models.js         # OLS, logistic (IRLS), weighted variants
│   │   ├── descriptives.js   # crosstabs, co-occurrence, trends, correlations
│   │   └── distributions.js  # normal/chi2/t quantiles, p-values, BH q-values
│   ├── reporting/
│   │   ├── methods.js        # methods-section generator, ledger-cited
│   │   ├── replication.js    # archive + generated R and Python scripts
│   │   └── report.js         # report canvas → standalone HTML
│   └── lexicons/             # vader.json, nrc-emolex.json, mfd2.json + LICENSES.md
├── app/
│   ├── index.html
│   ├── css/                  # tokens.css, base.css, components.css, screens/*.css, print.css
│   ├── js/
│   │   ├── main.js, router.js, api.js, state.js, bus.js
│   │   ├── components/       # rail, inspector, questionbar, ladder, charts/, quotecard,
│   │   │                     # confusion, table, toast, glyph (Director attribution)
│   │   └── screens/          # import, instantread, brief, explorer, constructs,
│   │                         # instruments, calibration, runs, workbench, disagreement,
│   │                         # reports, settings
│   └── fonts/                # Fraunces, IBM Plex Sans, IBM Plex Mono (woff2 + OFL)
├── projects/                 # project bundles (gitignored)
├── config/                   # keys.json, app.json (gitignored)
├── demo/
│   ├── generate.js           # seeded generator (committed; output reproducible)
│   └── techcorp-exit-survey.csv
├── docs/plans/
└── tests/
    ├── unit/                 # stats, parsers, dictionary, cache, ledger, privacy
    ├── sim/                  # DSL/PPI bias + coverage simulations
    ├── e2e/                  # full pipeline on demo corpus with MockModel
    └── fixtures/
```

## 4. Object model on disk

A **project bundle** is one folder under `projects/<slug>/`. Copying the folder copies the study.

```
projects/<slug>/
├── project.json          # graph: corpora, constructs, instruments, goldsets,
│                         # analyses, briefs, settings, privacyMode, budget
├── ledger.ndjson         # append-only events (see below)
├── corpora/<id>/
│   ├── meta.json         # source files, import mapping, unitization scheme, stats
│   └── units.ndjson      # {id, text, meta:{...}, pos:{doc, para, span}}
├── runs/<id>/
│   ├── run.json          # instrument version hash, model snapshot, params,
│   │                     # status, checkpoint, cost, escalation summary
│   └── outputs.ndjson    # {unitId, label, confidence, rationale, raw, judge,
│                         #  escalated, repaired, cacheKey}
├── gold/<id>.json        # sampling design, inclusion probabilities π_i, coder
│                         # labels (blind), adjudicated labels, agreement stats
├── analyses/<id>.json    # spec, results, ladder level, evidence links
├── briefs/<id>.json      # Corpus Brief artifact with per-claim evidence refs
└── cache/<aa>/<hash>     # content-addressed raw responses
```

Rules:

- **Writes are atomic:** write to `<file>.tmp`, fsync, rename. NDJSON files take appends only.
- **Ledger events** are hash-chained: `{ts, actor: "human"|"director"|"system", type, refs, payload, prev, hash}` where `hash = sha256(prev + canonical(event))`. The methods generator and the audit trail read only the ledger.
- **Instrument versions are content-addressed.** A version's hash covers prompt template, model id, snapshot, parameters, schema, and (for dictionaries) the full term list. Freezing at ● stores the hash in a calibration certificate; any edit forks a new version.
- **Cache keys:** `sha256(unitText + instrumentVersionHash + modelSnapshot)`. Re-runs and overlapping panels never pay twice.
- **Gold sets store π_i** (inclusion probabilities) at sampling time. DSL consumes them; the methods generator reports the design.
- **Silver sets** are gold-set objects with `tier: "silver"` and `coder: "director"`.

### Evidence Ladder

Level lives on the instrument version and propagates to analyses:

- ◌ Exploratory — compiles and runs; watermark travels into every export.
- ◑ Stabilized — passed stability check (k-run test–retest α on a subsample) and silver calibration.
- ● Calibrated — agreement vs human gold attached; instrument frozen (edits fork).
- ◉ Corrected — analysis computed with DSL/PPI against a gold set with stored π.

Levels never gate any action. Every level-up affordance states its price ("~150 units, ~35 min").

## 5. Provider layer

**Adapter contract** (`providers/base.js`): `complete({messages, schema, temperature, maxTokens, model}) → {text|json, usage, finishReason, raw}` plus `capabilities()` (structured output? batch? pinning?) and `catalog()`.

- **Adapters:** Anthropic (native tool-use for schemas), OpenAI (`json_schema`), OpenRouter (one key, long tail; serving-provider metadata recorded), Ollama/any OpenAI-compatible local endpoint (auto-discovery at `localhost:11434`), Mock (below). Google/Mistral/Cohere arrive via OpenRouter in v1.
- **Structured output:** native where supported; elsewhere constrained re-prompting with up to 2 repairs; still-failing units quarantine — never silently dropped.
- **Determinism:** temperature 0 default, pinned snapshot strings recorded per call, seeds where supported, randomized example/option order with recorded seed. Unpinnable backends are marked plainly in run records and the methods text.
- **Execution:** per-provider concurrency pools and rate limits, exponential backoff with jitter, checkpoint every N outputs (run resumes across restarts), hard budget caps abort cleanly and resumably.
- **Privacy modes enforced here,** not in UI: Open (any backend) · No-training (allowlist with citations; override requires logged justification → ledger) · Strict (network adapters disabled app-wide; Director must be a local model; product states its reduced ceremony). PII scan on import offers reversible pseudonymization; the mapping vault stays outside the project bundle and never syncs.
- **MockModel:** deterministic provider seeded by `sha256(unitText + instrument)`. Emulates a configurable-accuracy judge (default ~90% agreement with planted demo themes), generates plausible rationales from templates + unit text, costs $0, and is always labeled "Mock" in UI and methods text. Powers the keyless demo, CI, and e2e tests.

## 6. Orchestration engine

The Director is a configurable model slot (default: strongest available given keys and privacy mode; Strict mode requires a local model). Every Director function returns **artifacts** — never side effects:

- `brief.js` — stratified sample (~200–500 units) → streamed typeset memo: what the data is, languages, length/quality profile, candidate themes each anchored to ≥3 real quote refs, metadata relationships worth probing, suggested unit of analysis, red flags (duplicates, bots, PII). Every claim carries unit refs.
- `constructs.js` — themes/questions → formal construct entries (definition, inclusion/exclusion, edge cases, worked examples mined from corpus). Legacy codebook import: DOCX/PDF → proposed entries for review. Inductive mode labeled as hypothesis generation.
- `compiler.js` — construct → judging prompt targeted to worker class (more rubric anchoring, more examples, tighter constraints for small models), plus seeded dictionary term lists where the construct is lexical.
- `silver.js` — Director labels a few hundred sampled units once (silver). Worker prompt auto-iterates: run worker on silver sample → Director reads confusions → rewrites prompt → repeat until agreement plateaus (≤5 iterations, plateau = Δα < .01). Curve stored and displayed. Human gold supersedes silver.
- `panels.js` — recommends size, composition (disjoint families, budget- and privacy-aware), aggregation rule, with editable rationale.
- `escalate.js` — units flagged by low confidence, panel entropy, schema repair, or atypical length route to the Director; overrides marked `escalated: true` in outputs.
- `analyst.js` — post-run: proposes cross-tabs, contrasts, co-occurrences with one-line annotations, each linked to evidence, each dismissible.
- `questionbar.js` — plain-language question → visible plan: constructs (drafted), instruments, cost/time estimate, and the analysis it will produce. One click approves. Chat as compiler, never oracle.

Director-authored artifacts carry `authoredBy: "director"` and render with the attribution glyph until a human edits or accepts. Director tokens are metered like any other cost.

## 7. Measurement engine

- **Dictionaries** (`dictionary.js`): percent-of-words scoring faithful to LIWC convention; stems and wildcards (`abandon*`), phrases, weights, negation windows (configurable ±n tokens), boolean/regex rules; live highlighted preview; `.dic` import for LIWC license holders; bundled lexicons with licenses labeled in UI (VADER — MIT; NRC EmoLex — research use; MFD 2.0). Dictionaries run locally, free, and power the Instant Read.
- **Judges** (`judge.js`): judge = model + parameters + prompt template + output schema + decoding policy. Codebook compiles into the prompt. Schemas: binary, k-class, anchored Likert, 0–100, multi-label, extraction-with-spans. Rationale-before-verdict default; per-judgment confidence; one unit per call unless explicitly batched.
- **Stability check** (`stability.js`): k repeated runs (default k=3) on a subsample (default 100 units) → test–retest α. Runs automatically during silver calibration; passing earns ◑.
- **Panels** (`panel.js`): 3–5 workers from disjoint families; aggregation = majority | mean/median | unanimity-or-flag | confidence-weighted | reliability-weighted (weights from silver or gold agreement). Disagreement view ranks by entropy, cross-tabs juror×juror, shows side-by-side rationales. Disposition: route to human queue, or treat as codebook defect. Panel disagreement where humans agreed = instrument problem; where humans also disagreed = construct ambiguity — different colors, different fixes.

## 8. Calibration Studio

Six-step loop, reachable from any ladder badge:

1. **Sample** — SRS default; stratified; uncertainty sampling against current instrument. Sample-size guidance (~100–200 for binary at moderate prevalence). **π_i stored.**
2. **Code** — keyboard-first full-bleed sprint: j/k navigation, single-key labels, pinned definition, flag, memo, progress, session timer. Multi-coder blind enforced by server role, not convention. Human–human κ/α computes before any machine comparison; low human agreement surfaces as a construct problem first. Adjudication produces gold.
3. **Test** — instruments side by side vs gold: accuracy, κ, α (matched to type), AC1, per-class P/R/F1, confusion matrices, correlations for continuous. Bootstrap CIs throughout. Benchmark bands (α ≥ .80; .67–.80) rendered as context, never verdicts.
4. **Inspect** — every confusion cell opens its units. Director reads errors → hypotheses + candidate prompt/codebook edits, suggestion-mode.
5. **Revise & re-test** — edits fork versions; iteration log stores diffs + agreement deltas + McNemar so noise isn't mistaken for progress.
6. **Accept** — human freezes the instrument → calibration certificate (later, the reliability paragraph). Optional equivalence test: leave-one-coder-out α with TOST bounds.

## 9. Statistics

### Agreement (`agreement.js`)

Percent agreement, Cohen's κ (+ weighted), Krippendorff's α for nominal/ordinal/interval data with any number of coders and missing values, Gwet's AC1/AC2, per-class precision/recall/F1, confusion matrices. Bootstrap CIs (unit resampling). McNemar's exact/χ² test between instrument versions. TOST equivalence on leave-one-coder-out α.

### Correction (`correction.js`) — the differentiator

**DSL (design-based supervised learning), default wherever gold with π exists.** For estimand defined by moment condition E[m(Y, X; θ)] = 0, with machine labels Ŷ on all n units and gold Y on sampled units (R_i = 1, inclusion probability π_i):

- Pseudo-outcome: `Ỹ_i = Ŷ_i + (R_i/π_i)(Y_i − Ŷ_i)`
- Solve the moment condition with Ỹ in place of Y (mean, proportion, group difference, OLS; logistic via M-estimation on the score — pseudo-outcomes may exit [0,1], which estimating equations tolerate).
- Sandwich (robust) variance; CIs from normal quantiles.
- Properties: unbiased regardless of machine-error structure (design-based, since π is known); machine accuracy buys precision, not validity.

**PPI/PPI++** for means and proportions as the alternative estimator (power-tuning λ per PPI++). The workbench shows corrected (solid, ◉) beside naive plug-in (hollow/hatched, "uncorrected") wherever both exist.

**Predictor-side measurement error** ships exactly as the spec demands: documented honestly. v1 computes outcome-side correction; predictor-side renders with an advisory stating what is and is not guaranteed.

### Models (`models.js`)

OLS and logistic regression (IRLS) with HC1 sandwich SEs, weighted variants for DSL pseudo-outcomes. Descriptives: crosstabs with χ², co-occurrence matrices, time trends, correlation matrices across instruments. Honesty rails: BH q-values on demand, small-n warnings, no significance stars on ◌ results.

## 10. Testing

`node --test`, no framework. CI = `npm test` (a git pre-push hook runs it).

1. **Golden numbers** — hand-derived small cases where arithmetic is exactly checkable (2–4 coders, ≤20 units) for κ, α (all three metrics), AC1, F1; published worked examples cross-checked where stable (Cohen 1960; Gwet's AC1 example). Property tests: perfect agreement → 1; permutation invariance; missing-data handling.
2. **Simulations** (`tests/sim/`) — synthetic corpora with known truth; machine errors correlated with covariates by construction. Assert: |DSL bias| ≪ |naive bias|; 95% CI coverage within Monte-Carlo error; same for PPI on means. Seeded, deterministic.
3. **Parsers** — RFC 4180 edge cases (quoted newlines, BOM, ragged rows), XLSX/DOCX/PDF fixtures, VTT/SRT timing, junk detector, PII scanner.
4. **Engine** — cache hit/miss, checkpoint resume mid-run, quarantine on schema failure, budget-cap abort + resume, privacy-mode enforcement (Strict blocks network adapters at the adapter layer — test asserts no socket opens).
5. **E2E** — full pipeline on the demo corpus with MockModel: import → instant read → brief → compile → silver-tune → run → gold sample → code (scripted coders) → agreement → freeze → full run → DSL-corrected crosstab → methods text + replication archive. Asserts every ladder transition and ledger completeness (every reported number traces to events).
6. **Performance budgets** (from spec §10) as assertions: import 10k rows < 10s; dictionary scoring 50k units < 5s; Instant Read compute < 30s on 10k rows.

## 11. Server API (summary)

REST + SSE under `/api`. One route module per domain: `projects`, `import`, `corpora`, `brief`, `questionbar`, `constructs`, `instruments` (compile/silver-tune/stability), `goldsets` (sample/code/agreement/adjudicate), `runs` (preflight/start/monitor SSE/pause/resume/escalations), `analyses` (descriptives/crosstab/model/triangulation/subgroup), `evidence/:unitId` (assembled dossier), `exports` (methods/replication/report), `settings` (providers/keys/privacy/budget), `catalog/models`. Coder role: a launch profile whose session can reach only goldset coding endpoints, with machine labels and other coders' labels stripped server-side.

## 12. UI

Three-zone layout: left rail (project tree with inline ladder marks), center workspace, right evidence inspector summonable from any element ("every number is a door"). Question Bar top-center, always present, always compiling to artifacts.

**Design tokens** (`tokens.css`): Fraunces (display/Brief), IBM Plex Sans (UI), IBM Plex Mono (data/prompts/costs) — vendored woff2, OFL. Paper-and-ink palette: warm off-white ground `#FAF7F2`, near-black ink `#1A1815`, one accent (deep teal `#1F6F6B`); semantic constants: gold = `#B8860B` warm gold, machine = ink blue `#2B4C7E`, disagreement/uncertainty = signal orange `#C75000`, corrected = solid fills, uncorrected = hollow/hatch. Ladder marks ◌ ◑ ● ◉ render wherever a number does. Verbatim quotes: serif blocks with hanging quote glyph. Motion: 150–250ms, composed rows streaming in, nothing bounces. Dark mode. Print CSS at publication quality. WCAG AA; full keyboard operation; charts carry data-table equivalents.

**Screens:** Import sheet · Instant Read · Corpus Brief (full-bleed reading) · Explorer · Constructs/Codebook · Instrument editor (dictionary builder, judge editor, Panel Composer) · Calibration Studio (full-bleed sprint + agreement dashboard + iteration log) · Run monitor · Workbench (descriptives, crosstabs, models, triangulation, subgroup audit, Correction Reveal) · Disagreement view · Reports (methods, replication, canvas) · Settings.

## 13. Demo corpus

`demo/generate.js` (seeded, committed) emits `techcorp-exit-survey.csv`: ~2,500 synthetic exit-survey open-ends with metadata (dept, tenure_years, role_level, region, date, satisfaction 1–5). Planted themes (pay, management, workload/burnout, growth, remote policy, quit intent) with built-in correlations so cross-tabs land; plus junk rows, duplicates, bot-like repeats, varied lengths, a handful of Spanish responses. MockModel knows the planted themes, so the keyless First Five Minutes produces real-feeling results end to end.

## 14. Build order

1. **Foundation** — ids/hashing, store, ledger, objects, cache; `package.json`, `start.bat`, server skeleton, router, static serving.
2. **Parallel workstreams** (independent against §3–§5 contracts):
   a. Stats engine (TDD: golden numbers first, then simulations)
   b. Ingestion (parsers, mapping, unitization, junk, PII)
   c. Provider layer (base + 5 adapters + registry + costs + privacy)
   d. Dictionary engine + bundled lexicons
3. **Orchestration** — Director functions, judge/panel/stability, run engine (needs 2c).
4. **API routes** — wire 1–3 behind `/api`.
5. **UI** — tokens/base/components, then screens in product order: Import → Instant Read → Brief → Explorer → Constructs → Instruments → Calibration → Runs → Workbench → Disagreement → Reports → Settings.
6. **Reporting** — methods generator, replication archive (R + Python emit), report canvas.
7. **Demo + E2E** — generator, MockModel theme knowledge, full-pipeline test, performance assertions.
8. **Polish pass** — dark mode, print CSS, keyboard map, accessibility labels, empty states.

Each workstream lands with its tests. The e2e suite is the release gate: `npm test` green = the whole ladder works keyless on the demo corpus.
