# Concord

**Instrument-grade measurement of qualitative text. Explore in minutes, publish with honest statistics.**

Concord turns open-ended text — survey responses, interview transcripts, support tickets, field notes — into numbers you can defend. It has two gears. The first gear is fast: drop in a file and within minutes you have an Instant Read of the corpus, a Director-written brief anchored to real quotes, and exploratory counts of the themes that matter. The second gear is slow on purpose: constructs become formal codebook entries, codebooks compile into judging instruments (dictionaries, LLM judges, multi-model panels), instruments calibrate against human-coded gold samples, and every published estimate is corrected for machine error with design-based statistics (DSL/PPI) — so a model that is wrong 10% of the time still yields an unbiased number with an honest confidence interval.

The spine connecting the gears is the **Evidence Ladder**. Every number in Concord wears a mark telling you exactly how much it has earned: ◌ exploratory (it compiles and runs), ◑ stabilized (it agrees with itself across reruns and a silver calibration), ● calibrated (it agrees with humans on a designed gold sample, frozen with a certificate), ◉ corrected (the estimate itself is bias-corrected against gold with stored inclusion probabilities). Levels never block you — they label you. Exploration is cheap and honest about being exploration; publication is expensive and honest about what the expense bought.

And **every number is a door**. Click any count, bar, cell, or coefficient and the evidence inspector opens: the verbatim units behind it, the dictionary terms that fired, each model's rationale, the human gold label when one exists, the provenance of all of it. Under the hood, every action appends to a hash-chained ledger, methods sections write themselves with citations into that ledger, and one click exports a replication archive whose R and Python scripts reproduce every corrected estimate outside Concord.

---

## Quickstart (no API keys needed)

Prerequisite: **Node.js 20.10 or newer** on your PATH (`node --version`).

1. **Double-click `start.bat`** (first run installs dependencies — pure JavaScript, nothing compiles). Your browser opens `http://localhost:7341`.
2. **Create a project** (any name; privacy mode "no-training" is a fine default), then **drop `demo/techcorp-exit-survey.csv`** anywhere — 2,500 synthetic exit-survey responses.
3. Confirm the proposed mapping (the `response` column is auto-detected as text). The junk queue flags the planted non-answers, duplicates, and a 7-row bot burst.
4. Watch the **Instant Read** (all-local: length histogram, language mix, top terms — "pay" is right there, sentiment sketch, metadata marginals).
5. **Pick a Director**: the rail's *Project → Settings* (or the link under the Brief button) → The Director's slot → keyless demo: provider **mock** → Save.
6. Ask for the **Corpus Brief** and watch it stream in: candidate themes, each anchored to real quotes. Click a quote — that's the inspector.
7. From there, the whole ladder is open: accept constructs, compile instruments, silver-tune, run the corpus, draw a gold sample, code it in the Calibration Studio, freeze a certificate, and watch the Correction Reveal put the corrected estimate beside the naive one.

**What "Mock" means:** keyless, Concord runs on **MockModel** — a deterministic, $0, local fake model that knows the demo corpus's planted themes and emulates a ~90%-accurate judge with plausible rationales. It exists so the entire product (including calibration and correction, which need a fallible judge) works end to end before you paste a single key. It is always labeled "Mock" — in the UI, in run records, and in generated methods text. It never pretends to be science; it demonstrates the machinery that makes science possible.

## Adding real models

Open **Settings** (the gear route `#/settings`, or *Project → Settings* in the rail) and paste a key for any of:

- **Anthropic** — Claude models, schemas via tool-use.
- **OpenAI** — GPT models, native JSON-schema output.
- **OpenRouter** — one key for the long tail (Gemini, Mistral, Llama, …); the serving provider is recorded per call.
- **Ollama** — local models, auto-discovered at `localhost:11434`; $0 and nothing leaves your machine.

Keys live in `config/keys.json` — gitignored, outside every project bundle, never included in exports. Then pick a **Director** model in Settings (the strongest model you have; it writes briefs, drafts codebooks, compiles judge prompts, and gives second opinions on escalated units).

**Privacy modes** (enforced at the adapter layer, not the UI):

- **Open** — any configured backend may see unit text. For data with no confidentiality constraints.
- **No-training** — only backends with contractual no-training commitments (Anthropic, OpenAI) plus local models; anything else requires a justification that is written into the ledger.
- **Strict** — network adapters are disabled app-wide; everything (including the Director) must run on local models, and the product plainly states its reduced ceremony.

## The demo corpus

`demo/techcorp-exit-survey.csv` is **synthetic and fully seeded** (mulberry32, seed 7341 — `node demo/generate.js` regenerates it byte-identically). 2,500 exit-survey open-ends with metadata (dept, tenure, role, region, exit date, satisfaction 1–5) and six planted themes with built-in correlations so cross-tabs land:

| theme | base rate | planted correlation |
|---|---|---|
| pay | 0.28 | ↑ Sales (≈0.39), ↓ satisfaction |
| management | 0.22 | ↑ Operations |
| workload / burnout | 0.25 | ↑ tenure < 2 years |
| growth | 0.18 | ↑ IC role |
| remote policy | 0.12 | ↑ NA/EMEA |
| quit regret | 0.06 | flat, rare |

Quit-intent language fires mostly when satisfaction ≤ 2. Plus realistic dirt: ~2% junk ("n/a", "asdf", "."), ~1% exact duplicates, one 7-row bot burst, ~3% Spanish responses. `demo/oracle.json` records the exact per-row truth — that is what MockModel's oracle reads, and what the E2E suite checks corrected estimates against.

## Repo map

| path | what lives there |
|---|---|
| `start.bat` | double-click launcher (installs deps on first run, opens the browser) |
| `server/` | Node 22 ESM server — no framework, no build step |
| `server/core/` | project bundles, hash-chained ledger, object model, cache, ids |
| `server/ingest/` | CSV/XLSX/DOCX/PDF/VTT parsers, column mapping, unitization, junk + PII scans |
| `server/providers/` | Anthropic / OpenAI / OpenRouter / Ollama / Mock adapters, privacy gates, cost metering |
| `server/instruments/` | dictionary engine, LLM judge, panels, stability checks |
| `server/director/` | the Director: brief, construct drafting, prompt compiler, silver tuning, question bar |
| `server/runs/` | run engine (checkpoint/resume, budget caps, escalation) + live monitor |
| `server/stats/` | agreement (κ, α, AC1), bootstrap, DSL/PPI correction, OLS/logit — pure JS, golden-number tested |
| `server/reporting/` | methods generator (ledger-cited), replication archive, report HTML |
| `server/lexicons/` | bundled lexicons (VADER MIT; original CC0 starters) |
| `app/` | the browser UI — vanilla ES modules, hand-rolled SVG charts |
| `demo/` | seeded corpus generator + committed CSV + planted-truth oracle |
| `tests/` | unit, integration, simulation, and e2e suites (`node --test`) |
| `docs/plans/` | the design document and implementation plan |

## Running tests

```
npm test                                  # everything
node --test tests/e2e/pipeline.test.js    # the release gate: full pipeline, keyless, ~30s
node --test tests/e2e/perf.test.js        # performance budgets (10k import, instant read, engine run)
node --test tests/sim/dsl.sim.test.js     # Monte-Carlo validation of the DSL correction
```

The e2e pipeline drives the real server over HTTP exactly as the UI does: import → instant read → brief → constructs → compile → silver-tune → full run → gold sample → blind double-coding → human agreement first → adjudication → freeze → DSL-corrected crosstab → methods + replication exports → ledger verification.

## What's NOT in v1

Honest list, with where each deviation is documented (design doc §2, `docs/plans/2026-06-05-concord-v1-design.md`):

- **No local Whisper.** Transcripts import as VTT/SRT/JSON; audio transcription can attach later via any local OpenAI-compatible endpoint.
- **No end-to-end-encrypted relay.** Project bundles are plain portable folders — share a drive; blind coder sessions are restricted listeners started from the Calibration Studio, never a second server.
- ~~PII pseudonymization is built but not yet wired into import.~~ Wired since 2026-06-06: import-confirm takes `pii: "off" | "scan" | "pseudonymize"` (default scan). Scanning and masking cover unit text AND string metadata values (same reversible vault, same `[EMAIL_1]`-style tokens); the vault lives at `projects/<slug>/vault/<corpusId>.json` and is excluded from every replication archive. Re-unitizing re-runs the source corpus's pii mode on the derived corpus.
- **No OS keychain.** Keys sit in `config/keys.json` (gitignored, outside bundles and archives).
- **No SQLite/DuckDB.** NDJSON/JSON bundles with atomic writes and an append-only ledger — fluid to ~100k units, not 1M.
- **No embedded Python.** Statistics are pure JS, validated against hand-derived golden numbers and seeded simulations; replication archives emit R + Python that reproduce every corrected number outside Concord.
- **Predictor-side measurement-error correction** ships as documentation, not computation: v1 corrects outcome-side; predictor-side renders with an advisory.

## License

Private project — not yet licensed for distribution. (Bundled lexicon licenses: VADER MIT, Concord starter lexicons CC0 — see `server/lexicons/LICENSES.md`.)
