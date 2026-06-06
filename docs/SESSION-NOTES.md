# Concord — working notes (through 2026-06-06)

State: ~45 commits, full suite ~670 tests green (`npm test`; 1 intentional skip). Server runs DETACHED via `node server/index.js` (start.bat for the user); listens 127.0.0.1 AND ::1 on 7341. Repo lives in Dropbox → all atomic renames go through `store.renameWithRetry` (EPERM retry). Boot heals orphaned "running" runs to paused.

## Architecture pointers
- Contracts/amendments: docs/plans/2026-06-05-concord-v1-implementation.md ("Contract amendments" section is AUTHORITATIVE + ledger taxonomy).
- Provider dialects: openai.js `toOpenAIStrict` (all-required+nullable transform; OpenRouter inherits); judge + director calls ride `withTruncationRetry` (base.js) — reasoning models bill thinking against max_tokens; class budgets 2048/1536/1024 (compiler.js + panels.js copies).
- Quarantine entries are {unitId, code, message}; monitor race fixed: launchRun persists status=running BEFORE answering.
- UI conventions (user-enforced, three corrections): NO poetic copy — every string instructs; scope chips/context lines everywhere (components/scopechip.js, contextline.js); busy buttons show live timers; sheets lock during director calls; toast dedupe 4s; cite component for methodology claims.
- User's projects on disk: test-2 (favorite_books, gold in adjudication), new-survey (Kickstarter/Gender-for-Tech). OpenRouter key in config/keys.json (he will rotate).

## RESUME HERE — two queued fixes (chips task_09d115e9, task_5a77fef6; dismiss if done inline)
1. **BUG goldset corpus dropped** (user: coding sprint showed first corpus's column): audit creation paths — freeze sheet (instruments.js, should pass editor scope corpus), rail "+ New gold set" (main.js newGoldsetSheet default → most-recent), reliability empty-state create; SERVER: POST goldsets must store corpusId + SAMPLING must read that corpus (server/routes/goldsets.js — check sample route's unit source ≠ corpora[0]); sprint fetches via goldset.corpusId (calibration.js). Route test: goldset on corpus B samples B's unit ids. ALSO make Instant Read's "Unit text: <col> — change" prominent (instantread.js, own line near head).
2. **Live catalogs for anthropic/openai adapters**: GET /v1/models both providers when key present; merge pricing from static tables by id-prefix; fallback static when keyless/fetch-fail; hermetic canned tests like existing adapter tests; catalog route ?refresh=1 must bust 1h cache.

## Known deferred (next sessions)
PII pseudonymization built+tested but unrouted into import; mid-run budget re-check on resume; goldset resample/delete guards; stability per-rerun outputs not persisted (reliability screen omits retest rows honestly); panels CLASS_MAX_TOKENS consolidation chip; evidence-dossier test ~1/240 flake chip.
