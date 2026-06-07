# Concord — compressed working knowledge (through 2026-06-06, post roadmap wave 1)

READ THIS FIRST when resuming. Companion docs: `docs/plans/2026-06-05-concord-v1-implementation.md`
(**"Contract amendments" section is AUTHORITATIVE** — module interfaces + ledger event taxonomy) and
`docs/plans/2026-06-05-concord-v1-design.md` (design + recorded deviations from the product spec).

## State

- ~56 commits, **697/698 tests green** (`npm test`; 1 intentional skip: reporting artifact dump). Route suite
  lives at `tests/unit/routes.test.js`; wave-1 feature tests at `tests/server/*.test.js` (dir created 06-06).
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

**Deferred roadmap** (explicitly promised or flagged): mid-run/resume budget re-check; evidence-dossier
test ~1/240 flake; incremental brief streaming (one Director call, 30–60s composing wait); PII scan covers
unit text ONLY — metadata columns ride into replication CSVs unmasked (models never see them; flagged as
background chip); no goldset delete UI exists (server route + guarded wrapper ready). Gotcha for contracts:
`api.imports.confirm` destructures known fields and DROPS extras — never assume body passthrough in api.js.

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
