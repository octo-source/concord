# Concord v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (waves of parallel subagents; review between waves).

**Goal:** Build all of Concord v1 — the two-gear qualitative measurement instrument from spec v0.2 — as a local Node 22 app, fully tested, runnable keyless via MockModel.

**Architecture:** Node `http` server (no framework) + vanilla-ES-module browser UI. Project bundles are portable folders (NDJSON/JSON, atomic writes, hash-chained ledger). One provider abstraction with 5 adapters. Director/Worker orchestration. Pure-JS statistics with DSL/PPI correction, validated by golden numbers and simulation.

**Tech stack:** Node 22 ESM, `node --test`, pure-JS deps only: `xlsx`, `mammoth`, `pdfjs-dist`, `busboy`, `fflate`.

**Companion document:** `2026-06-05-concord-v1-design.md` (the design). Read it first. This plan adds executable contracts. Where they conflict, the design doc wins; flag the conflict rather than improvising.

**Discipline (every task):** TDD — write the failing test, see it fail, implement minimally, see it pass, commit. Frequent small commits (`git -C` the repo root; conventional messages `feat:`/`test:`/`fix:`). No new npm deps beyond the five listed. No native modules. Node built-ins only otherwise. All files ESM (`import`/`export`). Never use `Date.now()` in pure stats functions (determinism). Errors: throw `ConcordError(code, message, details)` from `server/core/errors.js`.

---

## Execution schedule (waves)

| Wave | Tasks in parallel | Task list IDs |
|---|---|---|
| 1 | A Foundation · B Stats · C Ingestion · D Providers · E Dictionary | #1 #2 #3 #4 #5 |
| 2 | F Orchestration+Runs · G Reporting · H1 UI design system/shell | #6 #9 #8(part) |
| 3 | I API routes · H2 UI screens | #7 #8(part) |
| 4 | J Demo corpus + E2E + perf · polish | #10 |

File ownership is disjoint per task — no two tasks edit the same file. Shared contracts live in this document. Wave-2+ tasks import Wave-1 modules; if an interface proves wrong, fix the consumer or flag — do not unilaterally change a Wave-1 export signature.

---

## Shared contracts

### Canonical JSON + hashing (`server/core/ids.js`)

```js
export function canonical(obj)        // JSON.stringify with recursively sorted keys, no whitespace
export function sha256(str)           // hex digest (node:crypto)
export function newId(prefix)         // `${prefix}_${timestamp36}${random36}` e.g. "run_abc123xy"
export function unitId(corpusId, rowIndex, text) // "u_" + sha256(`${corpusId}|${rowIndex}|${text}`).slice(0,16)
```

### Object shapes (stored in `project.json` unless noted)

```ts
Project   { id, name, slug, createdAt, privacyMode: "open"|"no-training"|"strict",
            budget: {capUSD: number|null, spentUSD: number},
            director: {provider, model, snapshot}|null,
            corpora: CorpusMeta[], constructs: Construct[], instruments: Instrument[],
            goldsets: GoldSetMeta[], analyses: AnalysisMeta[], briefs: BriefMeta[] }

Unit      { id, text, meta: Record<string, string|number|null>,
            pos: {doc?: string, row?: number, para?: number, turn?: number,
                  speaker?: string, t0?: number, t1?: number},
            flags?: {junk?: string, dup?: string, pii?: string[]} }   // in corpora/<id>/units.ndjson

Construct { id, name, type: "binary"|"nominal"|"ordinal"|"continuous"|"multilabel"|"extraction",
            categories?: {value: string, label: string, anchor?: string}[],   // nominal/ordinal/multilabel
            scale?: {min, max},                                               // continuous
            definition, criteria: {include: string[], exclude: string[]},
            edgeCases: string[], examples: {text, label, kind: "positive"|"negative"|"nearmiss"}[],
            authoredBy: "human"|"director", humanTouched: boolean, createdAt }

Instrument{ id, constructId, kind: "dictionary"|"rule"|"judge"|"panel"|"human",
            name, level: "exploratory"|"stabilized"|"calibrated"|"corrected",
            version: number, versionHash: string,        // sha256(canonical(payload))
            frozen: boolean, certificate?: Certificate, parentVersion?: string,
            payload: DictionaryPayload|JudgePayload|PanelPayload,
            stability?: {alpha: number, k: number, n: number, ranAt},
            silver?: {goldsetId, iterations: {versionHash, agreement, note}[]},
            authoredBy, humanTouched, createdAt }

DictionaryPayload { categories: {name, terms: {term, weight?}[]}[],   // term: "pay", "underpa*", "\"work life balance\""
                    negation: {enabled: boolean, window: number},
                    scoring: "percentOfWords"|"count"|"binary" }

JudgePayload      { provider, model, snapshot, params: {temperature, maxTokens, seed?},
                    promptTemplate: string,               // {{definition}} {{criteria}} {{examples}} {{unit}}
                    schema: OutputSchema, rationaleFirst: boolean, workerClass: "frontier"|"mid"|"small" }

PanelPayload      { jurors: JudgePayload[],   // 3–5, disjoint families
                    aggregation: "majority"|"mean"|"median"|"unanimityOrFlag"|"confidenceWeighted"|"reliabilityWeighted",
                    weights?: Record<string, number> }

OutputSchema      { type: "binary"|"kclass"|"likert"|"score0to100"|"multilabel"|"extraction",
                    options?: string[], anchors?: Record<string,string> }

GoldSet   // gold/<id>.json
          { id, constructId, tier: "gold"|"silver", design: "srs"|"stratified"|"uncertainty",
            strata?: {by: string},
            sample: {unitId, pi: number}[],               // pi = inclusion probability, REQUIRED
            coders: {coderId, blind: true, labels: Record<unitId, Label>,
                     memos?: Record<unitId, string>, flagged?: unitId[],
                     startedAt, finishedAt}[],
            humanAgreement?: AgreementReport,             // computed BEFORE machine comparison
            adjudicated?: Record<unitId, Label>, status: "sampling"|"coding"|"adjudicating"|"complete" }

Run       // runs/<id>/run.json
          { id, instrumentId, versionHash, corpusId, unitFilter?: string,
            status: "pending"|"running"|"paused"|"complete"|"aborted"|"failed",
            checkpoint: {done: number, total: number},
            cost: {estUSD, actualUSD, inputTokens, outputTokens},
            escalation: {count, directorModel}, quarantine: unitId[],
            startedAt, finishedAt, provider, model, snapshot, pinned: boolean }

Output    // runs/<id>/outputs.ndjson — one per unit per juror
          { unitId, juror: string,                        // juror = versionHash of judge, or "aggregate"
            label: Label, confidence?: number, rationale?: string,
            escalated?: boolean, repaired?: boolean, cacheHit?: boolean, raw?: string }

Label     = string | number | string[]                    // by construct type

Analysis  // analyses/<id>.json
          { id, kind: "descriptive"|"crosstab"|"model"|"triangulation"|"subgroup",
            spec: object, results: object,
            level: "exploratory"|"stabilized"|"calibrated"|"corrected",
            evidence: {cells: Record<string, unitId[]>}, createdAt }

LedgerEvent  // ledger.ndjson
          { ts, actor: "human"|"director"|"system", type: string,
            refs: Record<string,string>, payload: object, prev: string, hash: string }
          // hash = sha256(prev + canonical({ts,actor,type,refs,payload}))

Certificate { frozenAt, goldsetId, agreement: AgreementReport, humanAgreement: AgreementReport,
              versionHash, modelPinned: boolean, equivalence?: {tostP, bounds, alphaLOO} }

AgreementReport { n, metric per applicable type: {percent, kappa?, alpha?, ac1?, perClass?: {label, precision, recall, f1}[],
                  confusion?: number[][], labels?: string[], pearson?, ci?: {lo, hi, method}} }
```

### Provider adapter contract (`server/providers/base.js`)

```js
export class Adapter {
  constructor(cfg)                    // {apiKey?, baseUrl?, ...}
  async complete(req)                 // {model, messages:[{role,content}], schema?, temperature, maxTokens, seed?}
                                      // → {text?, json?, usage:{inputTokens,outputTokens}, finishReason, raw, servedBy?}
  capabilities()                      // {structuredOutput: bool, pinning: bool, batch: bool, local: bool, family: string}
  async catalog()                     // [{id, name, family, ctx, pricing:{inUSDper1M, outUSDper1M}, snapshot}]
}
export class Pool {                   // per-provider concurrency + backoff
  constructor({concurrency, rpm});  async run(fn)   // exponential backoff + jitter on 429/5xx, max 6 tries
}
```

Privacy enforcement: `registry.getAdapter(project, providerName)` is the ONLY constructor path; it throws `ConcordError("PRIVACY_BLOCKED", ...)` if the project's mode forbids the backend (strict → only `local: true` adapters; no-training → allowlist `["anthropic","openai"]` + local, override only with `{justification}` which is ledgered).

### API route table (all JSON; `{ok:true, data}` | `{ok:false, error:{code,message}}`; SSE where noted)

```
GET    /api/projects                          → ProjectSummary[]
POST   /api/projects                          {name, privacyMode} → Project
GET    /api/projects/:p                       → Project (full graph)
POST   /api/projects/:p/import                multipart file → {mapping proposal, preview rows, issues}
POST   /api/projects/:p/import/confirm        {mapping, unitization} → {corpusId, unitCount, junkQueue}
GET    /api/projects/:p/corpora/:c/units      ?offset&limit&q&meta filters → {units, total}
GET    /api/projects/:p/corpora/:c/instantread → {lengthHist, langMix, topTerms, sentimentSketch, metaMarginals}
POST   /api/projects/:p/brief                 {corpusId} → SSE: event=para data={md, refs:[unitId]} … event=done data={briefId}
POST   /api/projects/:p/questionbar           {question} → {plan: {constructs, instruments, estimate, analysis}, planId}
POST   /api/projects/:p/questionbar/:plan/approve → {constructIds, instrumentIds, runIds}
CRUD   /api/projects/:p/constructs[/:id]
POST   /api/projects/:p/constructs/import     multipart docx/pdf → proposed Construct[]
POST   /api/projects/:p/constructs/inductive  {corpusId, n?} → proposed taxonomy
CRUD   /api/projects/:p/instruments[/:id]
POST   /api/projects/:p/instruments/:i/compile      → new version (Director-authored prompt)
POST   /api/projects/:p/instruments/:i/silver-tune  {n?} → SSE: iteration events → final {agreement curve}
POST   /api/projects/:p/instruments/:i/stability    {k?, n?} → {alpha, pass}
POST   /api/projects/:p/instruments/:i/freeze       {goldsetId} → Certificate
POST   /api/projects/:p/instruments/:i/preview      {unitIds} → outputs (no persistence)
CRUD   /api/projects/:p/goldsets[/:id]
POST   /api/projects/:p/goldsets/:g/sample    {design, n, strata?} → sample with pi
GET    /api/projects/:p/goldsets/:g/next?coder=  → next unit for coder (blind)
POST   /api/projects/:p/goldsets/:g/label     {coder, unitId, label, memo?, flag?} → progress
GET    /api/projects/:p/goldsets/:g/agreement → {humanAgreement, perInstrument: AgreementReport[]}
POST   /api/projects/:p/goldsets/:g/adjudicate {unitId, label} → status
POST   /api/projects/:p/runs/preflight        {instrumentId, corpusId} → {units, calls, tokens, estUSD, etaMin, privacyOk}
POST   /api/projects/:p/runs                  {instrumentId, corpusId, capUSD?} → {runId}
GET    /api/projects/:p/runs/:r/monitor       → SSE: event=tick data={done,total,costUSD,labelDist,warnings} event=done
POST   /api/projects/:p/runs/:r/pause|resume|abort
GET    /api/projects/:p/runs/:r/escalations   → Output[] where escalated
GET    /api/projects/:p/runs/:r/disagreement  → {byEntropy: [{unitId, entropy, labels}], jurorMatrix}
POST   /api/projects/:p/analyses              {kind, spec} → Analysis (computed; DSL when goldset available)
GET    /api/projects/:p/evidence/:unitId      → {unit, dictionaryHits, outputs, goldLabels, sourcePos}
GET    /api/projects/:p/exports/methods       → {markdown, citations:[ledgerHash]}
GET    /api/projects/:p/exports/replication   → zip stream
GET    /api/projects/:p/exports/report        → standalone html
GET    /api/catalog/models                    → per provider catalog (cached 1h)
GET/PUT /api/settings                         keys (masked on GET), defaults, port
GET    /api/health                            → {ok, version, providers: {name: reachable}}
```

Coder profile: server started with `--coder <goldsetId>:<coderId>` serves ONLY `/`, static, `goldsets/:g/next`, `goldsets/:g/label`; everything else 403; responses never include machine labels or other coders' labels.

---

## Contract amendments after Wave-1 review (AUTHORITATIVE — supersedes anything above that conflicts)

**core:**
- `store.updateProject(slug, mutatorFn)` is THE way routes mutate projects (per-slug lock; mutator edits in place or returns a replacement). `saveProject` exists but raw read-modify-write is forbidden in routes.
- `loadProject` re-seals frozen instruments (`rehydrateProject`); `createInstrument` REJECTS `frozen: true` input. `versionInstrument` on the unfrozen path resets `level → "exploratory"` and drops `stability`/`silver`/`certificate`.
- `ConcordError(code, message, details, {status, cause})`; router status map: NOT_FOUND 404 · TOO_LARGE 413 · PRIVACY_BLOCKED 403 · RATE_LIMITED_EXHAUSTED 503 · default 400; explicit `status` wins.
- `sse(res)` → `{send, close, closed, onClose(fn)}`. `parseMultipart` limits: 200MB/file, 10 files, 200 fields.
- NDJSON torn-tail policy: a final line without trailing `\n` is a never-completed append — appends heal it, reads skip it, `ledger.verify` reports `{ok, length, tornTail?}`; mid-file corruption is a hard verify failure (`failedAt`).
- ONE process writes a bundle. The coder profile is a role inside the SAME server process (Task I), never a second process.
- `canonical()` honors `toJSON`. `listProjects()` may include `{slug, corrupt: true}` entries.

**Ledger event taxonomy** (F/G/I must agree; `refs` carry object ids):
`project.created` · `privacy.mode_changed` · `privacy.override` · `corpus.imported` · `corpus.unitized` · `construct.created` · `construct.edited` · `construct.deleted` · `instrument.created` · `instrument.versioned` · `instrument.compiled` · `instrument.silver_tuned` · `instrument.stability` · `instrument.frozen` · `instrument.deleted` · `goldset.created` · `goldset.sampled` (also one per human-queued unit, payload `{queuedUnit}`) · `goldset.label` (one per submitted label) · `goldset.agreement` · `goldset.adjudicated` · `goldset.completed` · `goldset.deleted` · `brief.generated` · `plan.compiled` · `plan.approved` · `run.preflight` · `run.started` · `run.completed` · `run.aborted` · `run.escalation_summary` · `analysis.created` · `export.methods` · `export.replication`. Actor convention: generation = `director`, mechanical = `system`, acceptance/user action = `human`. (`pii.pseudonymized` is reserved — the pseudonymizer is built and tested but not yet wired into import.)

**providers:**
- `registry.getAdapter` memoizes adapter instances (mock oracle state survives across calls); privacy gates still evaluated on EVERY call; `clearAdapterCache()` on settings change.
- Pool retries `PROVIDER_UNREACHABLE` 3× (idempotent calls); run engine treats a still-failing unit as RESUMABLE, not quarantined. Schema failures (SCHEMA_INVALID after repairs) quarantine.
- `completeWithRepair` returns `{…, repairs}` (repairs > 0 feeds the escalation predicate). OpenAI refusal → `PROVIDER_REFUSAL`; length-truncation with schema → `TRUNCATED`; neither enters the repair loop.
- Mock honors `req.seed` — stability checks MUST pass distinct seeds per rerun; `mock.setHandler(name, fn)` fires when the system message contains `[[handler:name]]` (Director scripting in tests/keyless mode).

**stats:**
- String-label ordinal/weighted statistics REQUIRE `{order: [...]}` (constructs' declared category order); pass it through from routes. `gwetAC2(data, {weights, order})` exists. `ppiMean` supports `lambda: "auto"` with overlap-correct variance (gold ⊂ corpus). `bootstrapCI` → `{lo, hi, method}`. `crosstab` → includes `minExpected`. `descriptives.timeTrend(rows, {dateKey, valueKey?, bucket})` exists. Coefficient rows report `z: null, p: null, note` when se = 0. Agreement functions reject `""`/NaN values and duplicate (unitId, coder) rows.

**dictionary:** `parseDic` → `{payload, warnings}` (LIWC conditional lines skipped with warnings). Misplaced `*` throws. Categories named `empty`/`NOT_*` rejected. `compile` memoizes raw payloads. Count mode sums every hit; percentOfWords dedupes token positions.

**ingest:** `pii.pseudonymize` accumulates into an existing vault (idempotent; `VAULT_CONFLICT` on remap). Transcript same-speaker merge gap ≤ 30s (`{maxMergeGapSeconds}` overrides).

---

## Task A — Foundation (`server/core/*`, server skeleton) [Task #1]

**Files:** `package.json`, `start.bat`, `server/index.js`, `server/router.js`, `server/core/{ids,errors,store,ledger,objects,cache}.js`, `tests/unit/core.test.js`

Steps (TDD, commit after each green):
1. `package.json` — `{"type":"module","scripts":{"start":"node server/index.js","test":"node --test tests/"}}`, deps pinned: `xlsx@^0.18`, `mammoth@^1.8`, `pdfjs-dist@^4`, `busboy@^1.6`, `fflate@^0.8`. `npm install` must succeed with zero build output.
2. Tests then impl for `ids.js`: `canonical` sorts keys recursively (`canonical({b:1,a:{d:2,c:3}}) === '{"a":{"c":3,"d":2},"b":1}'`); `sha256("abc")` = `"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"`; `unitId` deterministic.
3. `store.js`: `loadProject(slug)`, `saveProject(project)` (atomic: tmp+rename), `appendNdjson(path, obj)`, `readNdjson(path, {offset, limit, filter})` (streamed, never full-file for reads with limit), `listProjects()`. Test: write→crash-sim (leave .tmp)→load ignores tmp; append 10k lines then read offset 9990 limit 10.
4. `ledger.js`: `append(projectDir, actor, type, refs, payload)` → event with chained hash; `verify(projectDir)` → {ok, length} (recompute chain); `query(projectDir, {type?, ref?})`. Test: 3 events chain-verify; tamper middle line → verify fails at index 1.
5. `objects.js`: constructors + validators for all shapes above; `versionInstrument(inst, newPayload)` (bumps version, recomputes versionHash, refuses if frozen → forks with `parentVersion`); `freeze(inst, certificate)`. Test: freeze→edit throws; fork keeps lineage; versionHash stable under key order.
6. `cache.js`: `key(unitText, versionHash, snapshot)`; `get/put(projectDir, key)` under `cache/<first2>/<rest>`. Test roundtrip + miss.
7. `index.js` + `router.js`: static serving from `app/` (mime map), `/api/health`, JSON body parsing, SSE helper `sse(res)` → `{send(event,data), close()}`, error envelope, port from `config/app.json` (default 7341), `--coder` flag parsing. `start.bat`: `@echo off`, `cd /d %~dp0`, `if not exist node_modules npm install`, `start http://localhost:7341`, `node server/index.js`. Test: spin server on ephemeral port, GET /api/health → `{ok:true}`.

## Task B — Statistics engine [Task #2]

**Files:** `server/stats/{agreement,boot,correction,models,descriptives,distributions}.js`, `tests/unit/{agreement,correction,models}.test.js`, `tests/sim/dsl.sim.test.js`

**Signatures:**
```js
// agreement.js — data: array of {unitId, coder, value}; handles missing (absent rows)
percentAgreement(data) ; cohenKappa(data, {weighted?: "linear"|"quadratic"})
krippendorffAlpha(data, {level: "nominal"|"ordinal"|"interval"})
gwetAC1(data) ; perClass(data, goldCoder) → [{label, precision, recall, f1, support}]
confusion(data, coderA, coderB) → {labels, matrix}
// boot.js
bootstrapCI(data, statFn, {B=2000, seed, alpha=0.05}) → {lo, hi}     // unit resampling, seeded PRNG (mulberry32)
mcnemar(pairs) → {chi2, pExact, b, c}
tostEquivalence(data, {bound, level}) → {p, equivalent, alphaLOO: []}
// correction.js — units: [{yhat, y?, pi?, x?: number[]}]; gold rows have y and pi
dslMean(units) → {est, se, ciLo, ciHi, naive: {est, se}}
dslProportion(units) ; dslDiff(unitsA, unitsB)
dslOLS(units, k) ; dslLogit(units, k) → {coef: [{name, est, se, z, p}], naive: [...]}
ppiMean(units, {lambda?: "auto"})
// models.js
ols(y, X) → {coef, seHC1, r2} ; logit(y, X) → {coef, seHC1, converged}   // IRLS, max 50 iter
// distributions.js
normQuantile(p) ; chi2Cdf(x, df) ; tCdf(x, df) ; bhQValues(ps)
```

**Golden numbers (hand-derived — assert to 1e-9 unless noted):**
- κ: 2 coders, 20 units, counts yes-yes 8, no-no 7, AB-disagree 3, BA-disagree 2 → po=0.75, pe=0.50, **κ = 0.5** exactly.
- AC1 on the same table: π̄=0.525, pe=0.49875, **AC1 = 0.25125/0.50125 ≈ 0.5012468828**.
- α nominal: 2 coders, 4 units (AA, AA, BB, AB) → **α = 8/15 = 0.5333333333**.
- α nominal with missing: 3 coders, units {A,A,B}, {A,A,—}, {B,B,B} → **α = 0.5625** exactly.
- α interval: 2 coders, 3 units (1,1),(2,3),(4,4) → **α = 52/57 ≈ 0.9122807018**.
- McNemar b=3,c=2 → **χ²=0.2, pExact=1.0**.
- dslMean: Ŷ=[1,0,1,0], gold units 1,2 with π=0.5, Y=[1,1] → pseudo [1,2,1,0] → **est = 1.0** exactly.
- ppiMean classical (λ=1): Ŷall=[1,0,1,1,0,1], gold {1:1, 2:1} → **est = 2/3 + 1/2 = 7/6**.
- Property tests: perfect agreement → κ=α=AC1=1; α invariant to coder permutation; ordinal α with 2 categories equals nominal α; OLS recovers exact coefficients on noiseless data; logit matches sign + |z|>5 on separable-ish synthetic.

**Simulation (`tests/sim/dsl.sim.test.js`, seeded, ~30s budget):** n=2000 units, X~Bernoulli(0.5), true Y = Bernoulli(0.3 + 0.3X); machine Ŷ = Y flipped with error rate 0.25 when X=1 and 0.05 when X=0 (errors correlate with X — the DSL motivating case). Gold = SRS 300, π=300/2000. Over 200 Monte-Carlo reps: |mean(dslDiff est) − true diff| < 0.015 AND |naive bias| > 0.05 AND empirical 95% CI coverage ∈ [0.91, 0.985]. Same harness for dslLogit slope: DSL bias < ⅓ naive bias, coverage in range.

## Task C — Ingestion [Task #3]

**Files:** `server/ingest/{csv,xlsx,docx,pdf,text,transcript,mapping,unitize,junk,pii}.js`, `tests/unit/ingest.test.js`, `tests/fixtures/*`

Contracts: every parser → `{rows?: object[], docs?: {name, paras: string[]}[], turns?: {speaker, t0, t1, text}[]}`. `mapping.detect(rows)` → `{columns: [{name, role: "text"|"categorical"|"numeric"|"date"|"id"|"ignore", confidence, stats}]}` (text = mean length > 40 chars or >20 distinct long values; date = >80% parseable). `unitize(corpusId, parsed, scheme)` → `Unit[]` for schemes `response|sentence|paragraph|turn`. `junk.scan(units)` → flags: `na` (n/a, none, asdf row), `short`, `dup` (exact + whitespace-normalized), `bot` (≥3 identical non-trivial texts). `pii.scan(units)` → spans for emails/phones/SSN-like/names-heuristic; `pii.pseudonymize(units, vaultPath)` reversible, vault OUTSIDE bundle (`config/vaults/<project>.json`).

Fixture tests: CSV with quoted embedded newlines + BOM + ragged row (hand-write fixture; assert exact cell values); UTF-8 Spanish text intact; XLSX 3-sheet file (generate fixture with the `xlsx` lib in a setup script); DOCX/PDF tiny fixtures (commit binary fixtures ≤50KB; pdf fixture generated once via pdfjs-compatible minimal PDF — hand-authored PDF 1.4 with one text object is fine); VTT with hour-format timestamps; sentence unitizer on "Dr. Smith went home. She slept." → 2 units (abbreviation guard list).

Perf test: synthetic 10k-row CSV import end-to-end < 10s.

## Task D — Provider layer [Task #4]

**Files:** `server/providers/{base,anthropic,openai,openrouter,ollama,mock,registry,costs}.js`, `tests/unit/providers.test.js`

- Implement adapter contract above. Anthropic: `/v1/messages`, schema via forced tool-use (`tool_choice: {type:"tool"}`), record `anthropic-version`; OpenAI: `/v1/chat/completions` with `response_format: {type:"json_schema"}`; OpenRouter: OpenAI-compatible + `HTTP-Referer`/`X-Title` headers, record `provider` from response → `servedBy`; Ollama: `/api/chat` with `format: "json"`, auto-discover via GET `localhost:11434/api/tags` (300ms timeout).
- `mock.js`: deterministic. `complete()` hashes (model + last user message) → seeded PRNG → if message contains a `<unit>` block and a known schema, emit valid JSON with: label drawn to agree with an injectable oracle (`mock.setOracle(fn)`) at configurable accuracy (default 0.9), confidence ~ Beta-ish from seed, rationale templated from unit text snippets. Latency 5–20ms. `usage` plausible. Costs $0. Family "mock".
- `costs.js`: estimate = Σ per-call (promptTokens(unit, template)≈chars/3.6 + maxTokens) × catalog pricing; assert estimator within ±15% on mock runs (mock reports "actual" usage from same formula + noise — the test proves the plumbing, honestly labeled).
- `registry.js`: privacy gates per design §5. Tests: strict project + anthropic request → `PRIVACY_BLOCKED` thrown AND no fetch occurs (monkeypatch `globalThis.fetch` to throw if called); no-training + openrouter → blocked without justification, allowed with one, justification appears in ledger.
- Backoff test: mock HTTP server (node http on ephemeral port) returns 429, 429, 200 → adapter succeeds after 2 retries, delays ≥ base×2^n (fake timers not available — use small bases, assert call count + monotonic timestamps).

## Task E — Dictionary engine + lexicons [Task #5]

**Files:** `server/instruments/dictionary.js`, `server/lexicons/{vader.json, starter-emotions.json, starter-moral.json, starter-work.json, LICENSES.md}`, `tools/fetch-lexicons.js`, `tests/unit/dictionary.test.js`

- Tokenizer: lowercase, unicode-aware word chars + apostrophes; phrase matching ("work life balance" as quoted term); wildcards `underpa*` (prefix trie); weights; negation window (default 3 tokens look-back over {not, no, never, n't, without, hardly}) flips polarity for valenced categories; scoring per `DictionaryPayload.scoring`. `score(units, payload)` → per unit `{category: value}` + `hits(unit)` → spans for highlighting. `.dic` parser (LIWC format: `%` header block with category ids, then `term tab ids`).
- Lexicons: `tools/fetch-lexicons.js` downloads VADER lexicon (MIT) from the canonical vaderSentiment GitHub raw URL → `vader.json` {term: valence}; commit the JSON. NRC EmoLex is import-not-bundle (license) — document in LICENSES.md and support its TSV via `.dic`-style importer. Author original starter lexicons in-repo (clearly headed "Concord starter lexicon, CC0"): emotions (8 categories × ~40 terms), moral-intuitions (5 × ~30), work-themes (pay, management, workload, growth, flexibility — ~30 each, aligned with demo corpus themes).
- Tests: exact hit-counting on hand sentences ("I am not happy with my pay" → negation flips `happy`, work-themes.pay hits `pay`; percentOfWords = hits/tokens exact); wildcard; phrase; `.dic` round-trip. Perf: 50k synthetic units scored < 5s.

## Task F — Orchestration: Director, judges, panels, runs [Task #6]

**Files:** `server/director/{director,brief,constructs,compiler,silver,panels,escalate,analyst,questionbar}.js`, `server/instruments/{judge,panel,stability}.js`, `server/runs/{engine,monitor}.js`, `tests/unit/{judge,panel,runs,director}.test.js`

- `judge.assemble(construct, judgePayload, unit)` → messages; prompt template slots `{{definition}} {{criteria}} {{examples}} {{unit}}`; rationale-first JSON `{rationale, label, confidence}`; schema validation + ≤2 constrained repairs → else quarantine.
- `panel.aggregate(outputs, payload, weights?)` → all 5 rules + `entropy(labels)` (Shannon, natural log, normalized by ln k). `unanimityOrFlag` → label or `{flagged: true}`.
- `stability.run(instrument, units, {k=3, n=100})` → reruns with seed jitter, computes test–retest α via `krippendorffAlpha` treating runs as coders; pass = α ≥ 0.8 → level `stabilized` (with silver done).
- `runs/engine.js`: queue over units × jurors; per-provider `Pool`; checkpoint every 25 outputs to `run.json` (atomic); resume from checkpoint skipping cached/done; quarantine list; budget abort (`cost.actualUSD ≥ capUSD` → status aborted, resumable); escalation predicate (confidence < 0.6 | entropy > 0.7 | repaired | length > p99) → Director second opinion when Director configured, else flagged-only. Tests with MockModel: 500-unit run completes; kill mid-run (drop queue) → resume → exactly-once outputs; cache hit on second run = 100%, $0.
- `monitor.js`: per-run live state for SSE tick (done/total/cost/labelDist); degenerate warning (one label > 95% after ≥100 units); drift tripwire: re-run 20 gold units every 2000 outputs → alert if agreement drops >0.15 below certificate.
- Director functions: all return artifacts `{authoredBy: "director", humanTouched: false}` + ledger event. Prompts to the Director live in `server/director/prompts.js` as exported template strings (workerClass-conditional scaffolding per design §6). `brief.js`: stratified sample (by length tercile × up to 6 metadata cells), one streamed Director call, response contract = JSON paragraphs `[{md, refs: [unitId]}]` → SSE relay + persist `briefs/<id>.json`. `silver.js` loop: Director labels n=200 (one batched sequence of calls) → worker runs → confusion summary → Director rewrite (≤5 iterations, stop at Δα<0.01) → store curve. `questionbar.js`: question → `{constructs: Construct[], instruments, estimate, analysis: {kind, spec}}` via one Director call with strict JSON schema; approval materializes objects + preflight. With MockModel as Director (tests + keyless), `mock.setDirectorScript()` provides canned-but-valid artifacts so the full flow is exercised deterministically.

## Task G — Reporting [Task #9]

**Files:** `server/reporting/{methods,replication,report}.js`, `tests/unit/reporting.test.js`

- `methods.generate(project, analysisId)` → markdown with numbered sentences, each carrying `[ledger:<hash8>]` citation; sections: corpus/unitization, codebook process, gold design (+π), human reliability, instrument spec (model/snapshot/params/prompt availability), calibration results, aggregation, correction estimator. Template-based from ledger + objects — no LLM required (Director may polish wording later; not in v1 scope).
- `replication.build(project, analysisIds)` → zip (fflate): `codebook.md`, `instruments/*.json` (frozen payloads incl. prompts), `dictionaries/*.json`, `gold/*.csv` (+pi), `outputs/*.csv`, `agreement.json`, `analysis-specs.json`, `reproduce.R` (targets `dsl` package; emits the same DSL estimates), `reproduce.py` (numpy/statsmodels equivalents), `MANIFEST.json` with sha256 of every member.
- Test: build archive from a fixture project; unzip in-memory; `reproduce.py`'s embedded expected numbers equal Concord's computed analysis results to 1e-6 (we assert OUR numbers appear; running R/Python is out of CI scope — document this).
- `report.render(project, layout)` → single-file HTML (inline CSS/fonts subset, drill-down via embedded JSON + tiny script), print stylesheet.

## Task H — UI [Task #8] (H1 system+shell, H2 screens)

**Files:** everything under `app/`. H1: `index.html`, `css/{tokens,base,components,print}.css`, `js/{main,router,api,state,bus}.js`, `js/components/*` (rail, inspector, questionbar, ladder, glyph, toast, table, quotecard, confusion, charts/{bar,line,scatter,heat,small-multiples}.js — hand-rolled SVG, direct labels, no gridlines heavier than data). H2: `js/screens/{import,instantread,brief,explorer,constructs,instruments,calibration,runs,workbench,disagreement,reports,settings}.js` + per-screen CSS.

- Design tokens exactly per design doc §12 (palette hexes, semantic encodings, ladder marks ◌◑●◉, serif quote blocks with hanging glyph, 150–250ms transitions, dark mode via `prefers-color-scheme` + toggle, WCAG AA contrast).
- Fonts: `tools/fetch-fonts.js` downloads woff2 (Fraunces 400/600/900 + italic, Plex Sans 400/500/600, Plex Mono 400/500) from fontsource jsDelivr (`https://cdn.jsdelivr.net/fontsource/fonts/<family>@latest/latin-<w>-normal.woff2`) → `app/fonts/` + OFL texts. Graceful fallback stacks if absent; build must not require network.
- `api.js`: typed wrappers for every route in the table + `sseSubscribe(url, handlers)`. `state.js`: single store + pub/sub bus; route-driven screens; no framework.
- Screen acceptance (verified in Wave 4 with preview tools): Import sheet (drop anywhere → parsed sheet slides up, column chips editable, issues as annotations); Instant Read (renders < 1s after confirm from `instantread` endpoint, all-local badge); Brief (full-bleed reading column, paragraphs stream in, margin quote-pulls, every claim click → inspector); Explorer (prevalence bars with ◌ badges, Director-flagged cross-tabs, co-occurrence sketch, footer calibration nudge with price); Constructs (structured editor, Director glyph until touched, worked-examples table); Instruments (dictionary builder with live highlighted preview; judge editor with compiled-prompt view + raw escape hatch; Panel Composer with live cost-per-1k and family-disjointness warning); Calibration Studio (full-bleed sprint: j/k, 1-9 labels, f flag, m memo, pinned definition, progress + session timer; agreement dashboard: side-by-side instruments, clickable confusion heat-tables; iteration log sparkline); Runs (preflight sheet with cost/eta/privacy check → live monitor: progress, running cost, label-dist mini-bars, warnings, escalation queue); Workbench (crosstab builder, model builder, Correction Reveal: corrected solid vs naive hatched on one axis with Δ annotation; triangulation scatter + divergence browser; subgroup audit table); Disagreement (entropy-ranked list, juror×juror grid, facing-column rationales); Reports (methods preview with citation chips, replication download, report canvas arrange/export); Settings (provider cards with key entry → masked, model catalog, privacy mode with mode-change ledgered, budget cap, Director slot).
- Evidence inspector (the soul): summonable from ANY number/bar/cell via `data-evidence` attribute convention + delegated handler; shows unit text (serif), dictionary hits highlighted, each juror's label+rationale, gold label when exists, source position, ladder level of every displayed number.
- Every chart component renders an accessible `<table>` twin (visually-hidden, toggleable).

## Task I — API routes [Task #7]

**Files:** `server/routes/{projects,import,corpora,brief,questionbar,constructs,instruments,goldsets,runs,analyses,evidence,exports,settings,catalog}.js`, `tests/unit/routes.test.js`

Implement the route table verbatim over Tasks A–G modules. Every mutating route appends a ledger event. Goldset label route enforces coder blindness server-side. Analyses route auto-selects DSL when the construct has a complete gold set with π (level `corrected`), else naive (level = instrument level). Integration tests: boot server on ephemeral port with a fixture project; exercise happy path per domain + 403s for coder profile + privacy-blocked run.

## Task J — Demo + E2E + performance [Task #10]

**Files:** `demo/generate.js`, `demo/techcorp-exit-survey.csv` (committed output), `tests/e2e/pipeline.test.js`, `tests/e2e/perf.test.js`, `README.md`

- Generator (seeded mulberry32, seed 7341): 2,500 rows; columns `respondent_id, dept(6), tenure_years, role_level, region(4), exit_date, satisfaction(1-5), response`. Themes with planted base rates and correlations: pay (0.28; ↑sales, ↓satisfaction), management (0.22; ↑ops), workload-burnout (0.25; ↑tenure<2), growth (0.18), remote-policy (0.12; region-skewed), quit-regret (0.06). Quit-intent language correlates with satisfaction ≤2. Compose responses from theme clause banks (~40 clauses/theme, varied registers + lengths 5–120 words); 2% junk ("n/a", "asdf", "."), 1% exact dupes, one bot-burst (7 identical), ~3% Spanish responses. MockModel oracle reads the planted theme flags via `mock.setOracle` wired to generator metadata (committed alongside as `demo/oracle.json`).
- E2E (MockModel everywhere incl. Director): create project (no-training) → import CSV (assert mapping auto-detects `response` as text) → instant read (assert top terms include "pay") → brief (assert ≥4 themes with ≥3 refs each) → accept themes → compile instruments → silver-tune (agreement curve non-decreasing) → stability (◑) → preflight (estUSD > 0, mock) → full run (2500 units, completes, label dist within ±10% of planted rates) → goldset SRS n=150 (π = 150/2500 stored) → two scripted coders (oracle + 8% noise) → human κ computed first and > 0.7 → adjudicate diffs → test instrument (κ vs gold > 0.7) → freeze (●, certificate) → crosstab pay×dept with DSL (◉; corrected CI covers planted truth; naive shown) → methods markdown contains model, snapshot, π, κ, estimator sentences each with ledger citations → replication zip contains all members + MANIFEST hashes verify → ledger.verify ok. This test is the release gate.
- Perf assertions per design §10. README: what Concord is, double-click quickstart, keyless demo walkthrough, adding real keys, privacy modes, repo map, test commands.

## Wave-4 polish checklist
Dark mode pass on every screen · print.css for methods/report · keyboard map overlay (?) · ARIA labels + chart tables · empty states for every screen · `npm test` green · manual preview verification of the First Five Minutes against budgets · final code-review subagent pass (superpowers:requesting-code-review) · commit.
