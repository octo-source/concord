# Concord — compressed working knowledge (through 2026-06-06, post roadmap wave 1)

READ THIS FIRST when resuming. Companion docs: `docs/plans/2026-06-05-concord-v1-implementation.md`
(**"Contract amendments" section is AUTHORITATIVE** — module interfaces + ledger event taxonomy) and
`docs/plans/2026-06-05-concord-v1-design.md` (design + recorded deviations from the product spec).

## State

- ~88 commits, **854/855 tests green** (`npm test`; 1 intentional skip: reporting artifact dump). Route suite
  lives at `tests/unit/routes.test.js`; feature/audit tests at `tests/server/*.test.js`.
- DISTRIBUTED: private GitHub repo github.com/emollick/concord (gh CLI; config/ + projects/ gitignored and
  history-verified clean; .gitattributes forces LF so Windows clones don't corrupt CSV fixtures; Mac/Linux
  run = npm install + npm start). Fresh-clone install is the distribution gate (clone → npm install → suite →
  boot probe).
- Server: run DETACHED — `Start-Process cmd "/c node server\index.js > server-boot.log 2>&1" -WorkingDirectory <repo> -WindowStyle Hidden`. Kill prior port owners first (`Get-NetTCPConnection -LocalPort 7341`). Listens on 127.0.0.1 AND ::1. start.bat = the user's entry. NEVER serve via the preview tool (its servers get reaped → zombies).
- After every server change: restart detached + tell Ethan to FULL-reload (Ctrl+F5).
- His projects on disk: `test-2` (favorite_books_people.csv; ordinal construct "Book Enthusiasm Level"; gold set `gs_mq1y81ut0j0zz658oe` in adjudication; one complete gemini run), `new-survey` (Gender for Tech.xlsx, reunitized to abouttxt). OpenRouter key in config/keys.json (he will rotate it).

## Goals / direction

Concord = instrument-grade qualitative text measurement (spec v0.2, fully built): corpora → constructs →
instruments (judge/dictionary/panel) → runs → gold calibration → DSL/PPI-corrected statistics, Evidence
Ladder ◌◑●◉ throughout, provenance ledger, methods/replication exports. Current phase: **field-hardening
from Ethan's real use** — he tests, reports, we fix same-day. He is mid-flight: finishing adjudication on
test-2, then the Reliability screen (built for him: pairwise κ/α matrix across instruments/coders/gold) and
Workbench analyses. Next likely asks: more model comparisons, the labeled-CSV in his workflow, report assembly.

**Shipped in roadmap wave 1 (2026-06-06, four parallel agents):** goldset resample/delete guards (409
CONFIRM_REQUIRED + counts; forced resample CLEARS stale labels/adjudications/finishedAt/humanAgreement;
ledger `goldset.resampled`); stability reruns persisted (`projects/<slug>/stability/<instrumentId>.json`)
→ Reliability `retest:<inst>:<k>` sources + mean rerun-vs-rerun α line; PII wired into import confirm
(`pii: off|scan|pseudonymize`, default scan; vault in-bundle at `vault/<corpusId>.json`, excluded from
replication archive; real token format `[EMAIL_1]`); report routes pinned in shapes suite.

**Shipped 2026-06-06 (pii follow-up, closes the metadata gap):** scan/pseudonymize/reidentify cover STRING
metadata values like unit text (same vault, same tokens, types preserved; non-strings untouched) — so
replication `units/<id>.csv` and Director prompts (`renderUnit` shows meta k=v — the "models never see
metadata" claim was judge-only) no longer carry raw identifiers off pseudonymized corpora. Reunitize RE-RUNS
the source corpus's pii mode on the derived corpus (absent record → scan, the import default; pseudonymize
seeds `vault/<derivedId>.json` from the parent map — parent vault read, never written; parent vault MISSING →
VAULT_CONFLICT rather than reminting tokens; counts = what THIS pass found/replaced, so zero when import
masking already covered the promoted column); `pii` rides reunitize response + derived entry +
`corpus.unitized` payload, `pii.pseudonymized` ledgered on masked reunitize; reunitize toast reuses import's
`piiSummary` line. Tests: `tests/server/pii-reunitize.test.js`, meta cases in pii-import + ingest suites.

**Shipped 2026-06-08 (code-correctness review + visualizations):** a 6-reviewer read-only bug hunt
(security/traversal, engine-room ×2 incl. an empirical pass, stats, routes/listener, UI) + a viz survey.
**Verdicts: stats provably correct** (every estimator re-derived; PPI++ overlap variance + logit refit
machine-checked), **isolation/CSV-injection/prototype-pollution safe by attack.** Fixed: a CONFIRMED path
traversal that leaked config/keys.json (`safeId` at the path-builder seam — analyses/briefs/import/exports

- slug; tests/server/path-traversal.test.js); the engine root-cause (forEachUnit kept billing after a
  worker threw + could dup resume lines → stop-on-throw); driftTick crash path; appendNdjson per-file
  serialization + EPERM retry (Dropbox); quarantine-clear-on-resume; persistRun in-place; double-launch
  poison; evidence "1/240 flake" was a swallowed read error; Anthropic/Ollama TRUNCATED classification;
  OpenRouter catalog cache (zeroed-metering); process-crash guard (persistent listener 'error' + process
  guards); Brief/silver-tune abort-on-disconnect; UI long-session leaks (asyncMount route-token guard,
  instruments destroy, sheets-close-on-nav, drag-drop double-fire, brief race). VIZ: forest plot
  instruments-vs-gold w/ per-instrument bootstrap CI (`perInstrument[].agreement.ci`; components/charts/
  forest.js), coefficient forest for corrected regressions, confusion-matrix SVG in the HTML report.
  Deferred: reliability-matrix-as-report-SVG; per-class P/R/F1 grouped bar (chip task_168b8eed); ledger
  double-lock on the append path (harmless); mid-execution project-budget recheck.

**Shipped 2026-06-06 (alt judges + accuracy-audit campaign):** stability checks accept ≤4 alternate models
(same compiled prompt, same sample, once each) → Reliability `alt:<inst>:<provider>/<model>` rows incl.
alt-vs-gold; "Duplicate with another model" promotes a winner. Then a 6-auditor sweep traced EVERY UI claim
to code (~25 HIGH/~32 MED) and 5 parallel fixers closed them — system fixes: consensus gold needs ≥2
unanimous + no conflict; excluded units leave human agreement; unanimous-uncodable queues for adjudication;
sprint structurally blind via /next (examples now shown to humans); resample seed salted; adjudication
validates labels; stratified min-1/stratum; bootstrap CI on agreement (`humanAgreement.ci`); outputs keyed
on run.versionHash everywhere (finalJurorOfRun — instrument edits can't blank runs/exports/resume/gold
comparisons); escalation failures classified (no billing-while-failed zombies); run.error rendered; raw
numbers never wear ◉ (per-bar provenance; χ²-on-raw disclosed); quarantines tick the monitor; labelDist
persisted; uncertainty-design gold never mints ◉; judge prompts render declared scale bounds; Director
repair attempts metered; column role "ignore" drops from meta/prompts/exports (corpus.columnRoles);
import reports skipped rows; replication scripts binarize per recorded positive + per-cell + label filter
(reproduce.py EXECUTED in tests to 1e-6); methods prose conditioned on what's enforced (snapshot recorded-
not-verified, per-provider seed clauses, Director-conditional escalation, "as recorded at export time",
nominal-π disclosure, weighted-κ naming, ledger-proven silver-before-gold); methods PREVIEW route (visits
stop minting export events); gold-verbatims opt-out (?goldText=0); stability response carries `level` (no
false ◑ claims); stability artifacts version-stamped ("earlier version" marking); + New construct button.

**Shipped 2026-06-07 (roadmap completion, four parallel agents):** HUMAN CODER SCREEN (app/coder.html +
js/coder.js — blind page driving /api/coder/* only, keyboard-first, pinned codebook; listener gains {host}
opt-in 0.0.0.0 + lanUrl for handing a second coder a LAN link; session sheet rebuilt; goldset Delete button
wired to the CONFIRM_REQUIRED guard); BRIEF PROGRESS (server stage events sampling/prompt-composed/
director-called + 2s elapsed ticks, ticker cleared on settle; screen shows live stage line); INSTANT READ
EVIDENCE (every chart bin carries ≤100 unitIds + true n — bars open the inspector); PER-ATTEMPT METERING
(base.js attemptsUsage accumulates all returned attempts; engine meters at its adapter seam; Director
wrapper removed; quarantined spend reaches run.cost); RESUME BUDGET GATE (remaining-units re-estimate,
same gate/error as start); CORRECTED-REGRESSION REFIT CODEGEN (R+py rebuild pseudo-outcomes and refit
dslOLS/dslLogit to 1e-6 — reproduce.py EXECUTED in tests); inductive-origin construct field + methods
sentence; legacy reporting pins assert the honest wording; fixtures methodsPreview patch; reunitize
copies adjusted columnRoles. Dossier flake: NO REPRO in 138 full-suite runs; suspect = evidence.js
swallowed transient reads (.catch(() => []) on outputs / null on goldset) — revisit only with a captured
failure.

**Deferred (small, recorded):** judge.js could forward attemptsUsage in judgeUnit's return so the engine
meters from the response (simplifies the adapter-seam wrapper, engine.js:300-305); the PROJECT budget is
gated at start+resume but not re-checked mid-execution (a cap lowered while a run executes is noticed at
settle); derived columnRoles can carry two "text" entries when the demoted column reads as prose
(cosmetic — corpus.textColumn is authoritative); .codeline copy-button label wraps in very narrow sheets.
Gotchas: `api.imports.confirm` destructures known fields and DROPS extras — never assume body passthrough
in api.js; test files are shared ground — concurrent fixers editing the same test file works but watch
for last-writer pins; the workspace-root .claude/launch.json is shared across projects — remove throwaway
preview entries after browser verification.

## Recurring error classes + the approaches that beat them

1. **Provider dialects differ silently; hermetic tests lie about them.** OpenAI-strict json_schema demands
   every property required (optionals → `type:[T,"null"]` — `toOpenAIStrict` in openai.js, OpenRouter inherits);
   Gemini-class reasoning models bill THINKING tokens against max_tokens (budgets: workers 1024/1536/2048 +
   `withTruncationRetry` once-at-2× in base.js, judges cap 8192); OpenRouter silently IGNORES response_format
   on unsupported models (repair loop catches). **Approach: reproduce against the real provider with throwaway
   probe scripts in $env:TEMP before theorizing; his key is configured.**
2. **Parallel-agent drift.** Fixtures vs live shapes diverged across 11 screens once. **Approach: pinned
   contracts in both prompts + `tests/e2e/shapes.test.js` pins every screen's reads to live routes — extend it
   with any new route/screen.**
3. **Silent failures compound.** Toast flood → flicker → empty previews were one family: handlers ignoring
   status/echo loops + quarantine without reasons. **Approach: status-aware handlers; re-render only on actual
   state change; quarantine carries {unitId, code, message}; failure panels, never empty results; toast dedupe.**
4. **The repo lives in Dropbox.** Transient EPERM on rename (sync locks) → `store.renameWithRetry` wraps all
   5 atomic-write sites. Stray `*.tmp.*` files = killed-process debris, safe to delete (gitignored).
5. **Process hygiene on Windows.** Zombie servers hold 7341 wedged (accept, never answer) — check
   `Get-NetTCPConnection`, kill ONLY identified-ours (`Get-CimInstance Win32_Process` for command lines; Adobe +
   `Documents\Qual` processes are NOT ours). Orphaned "running" runs: boot sweep + monitor heal → paused/ORPHANED.
6. **PowerShell 5.1 quirks**: no `??`/`&&`; `node -e` quote-mangling → write temp .mjs files instead; background
   Bash with timeout KILLS spawned servers (use detached Start-Process for anything that must outlive the call).
7. **Model outage mid-agent** (it happened): red-first tests survive as the spec; a recovery agent (explicit
   `model: "opus"`) completes from `git diff` + failing tests. Red tests ARE the handoff format.
8. **Preview tool**: screenshots time out (use preview_eval DOM/computed-style probes); `?fixtures=1` persists
   via localStorage and pollutes later live checks (clear + location.reload() — hash nav does NOT reload).

## Ethan's standards (enforced through ~8 feedback rounds — violations are bugs)

- **Copy instructs, never decorates.** Every string says what a thing IS or what to DO, with worked examples
  in placeholders. He flagged poetry three times ("this isn't an adventure game!").
- **Scope/provenance always visible**: which column, corpus, rows, exclusions — scope chips + context lines
  ("measures X · reads Y — text: col") on every object screen; operations covering all columns SAY so.
- **Buttons show live state** ("Running the inductive pass · 14s"), sheets lock during paid calls, double-clicks
  absorbed, >2s actions get progress with honest ETAs.
- **One obvious next action per stage** (pipeline strip Construct→Instrument→Run→Calibrate→Corrected).
- **Methodology claims carry citations** (components/cite.js: krippendorff2004, landiskoch1977, cohen1960,
  gwet2014, egami2023, angelopoulos2023, donner1992).
- Names are researcher-facing (runs "<instrument> · <corpus>", goldsets "Gold — <construct>", renameable).

## Working method that has been producing

Parallel general-purpose agents with disjoint file ownership + pinned interface contracts; strict red-first TDD
(hand-derived golden numbers for stats — adversarial independent re-derivation caught a real PPI++ variance
error); spec-review + quality-review agent rounds on big drops; live reproduction of every field bug BEFORE
fixing; commit per round (path-scoped, detailed messages); full suite is the gate (flaky timing tests get
margins/re-measures, not deletions).
