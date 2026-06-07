// Runs — #/p/:slug/runs[/:id] — the measurement actually happening. The LIST
// groups runs under the corpus they read (most recently measured corpus
// first, runs newest-first within), each row wearing the run's name
// (auto-named "<instrument> · <corpus>"; legacy runs derive the same shape).
// The preflight sheet quotes units × calls → tokens → dollars ±15%, ETA,
// privacy check, budget remaining, hard cap, with ONE start button. A running
// run gets the live monitor: progress rule, running cost in mono, label
// distribution accumulating as mini-bars, a warnings feed, the escalation
// queue, the quarantined-units list ({unitId → code: message}, never silent),
// and pause/resume/abort. The detail's renameable title is the run's name;
// the context line under it states ran <instrument> on <corpus> · measures
// <construct>. Completed runs hand off to the Explorer.

import { el, clear, frag } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as ladderC from "../components/ladder.js";
import * as bar from "../components/charts/bar.js";
import * as scopechip from "../components/scopechip.js";
import * as renameable from "../components/renameable.js";
import { contextLine, corpusText } from "../components/contextline.js";
import { fmtCost, fmtCount, fmtStat, fmtDuration, fmtDateTime } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, refreshProject, emptyState, openSheet, kv, kvList, normalizeQuarantine, runDisplayName } from "./_shared.js";

export const route = "p/:slug/runs";
export const routes = ["p/:slug/runs", "p/:slug/runs/:id"];
export const title = "Runs";

let monitor = null;

export function render(mount, params, query) {
  if (params.id) {
    return renderDetail(mount, params);
  }
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    return { project, runs: project.runs ?? [], instruments: project.instruments ?? [] };
  }, ({ project, runs, instruments }) => {
    mount.append(screenHead({
      overline: "Runs",
      title: "Measure the corpus.",
      lede: "A run applies one instrument to the whole corpus. You see the estimated cost before starting and the running total while it goes; an interrupted run resumes where it stopped without paying again for finished units. Completed runs feed the Workbench.",
      actions: [
        el("button", {
          class: "btn btn--primary", type: "button",
          onclick: () => preflightSheet(params, project, instruments, query.preflight),
        }, "New run…"),
      ],
    }));

    if (!runs.length) {
      mount.append(emptyState({
        title: "No runs yet.",
        body: "Pick an instrument, check the cost estimate, and start it reading the corpus.",
        actions: [el("button", { class: "btn btn--primary", type: "button", onclick: () => preflightSheet(params, project, instruments, query.preflight) }, "Preflight a run")],
      }));
    } else {
      mount.append(runGroups(params, project, runs));
    }

    if (query.preflight) preflightSheet(params, project, instruments, query.preflight);
  }, "Listing runs…");
}

/* The list, grouped under the corpus each run reads: most recently measured
   corpus first, runs newest-first within a group. Runs whose corpusId no
   longer matches a project corpus (or was never recorded) gather under
   "Other" at the end — named, never dropped. */
function runGroups(params, project, runs) {
  const corpora = project.corpora ?? [];
  const newestFirst = [...runs].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));

  const groups = new Map(); // corpusId | "__other__" → runs, insertion = newest run first
  for (const r of newestFirst) {
    const key = corpora.some((c) => c.id === r.corpusId) ? r.corpusId : "__other__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    (a[0] === "__other__" ? 1 : 0) - (b[0] === "__other__" ? 1 : 0));

  const out = frag();
  for (const [key, groupRuns] of ordered) {
    const corpus = key === "__other__" ? null : corpora.find((c) => c.id === key);
    const head = el("div", { class: "rungroup__head" },
      el("h3", { class: "overline rungroup__title" },
        corpus ? scopechip.displayName(corpus) : "Other"),
      corpus
        ? scopechip.render(scopechip.fromCorpus(corpus, project))
        : el("p", { class: "scopechip faint" }, "runs whose corpus is no longer in this project, or was never recorded"));

    const list = el("div", { class: "runlist" });
    for (const r of groupRuns) list.append(runRow(params, project, r));
    out.append(el("section", { class: "screen__section rungroup" }, head, list));
  }
  return out;
}

// live run record: progress under checkpoint {done, total}; cost under
// cost {estUSD, actualUSD, inputTokens, outputTokens}
function runRow(params, project, r) {
  const done = r.checkpoint?.done ?? 0;
  const total = r.checkpoint?.total ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const qN = (r.quarantine ?? []).length;
  return el("a", { class: "runrow", href: `#/p/${params.slug}/runs/${r.id}` },
    el("span", { class: "runrow__name", title: r.id },
      runDisplayName(project, r),
      qN > 0
        ? el("span", {
            class: "chip chip--signal runrow__quar data",
            title: `${fmtCount(qN)} unit${qN === 1 ? "" : "s"} produced no valid output — open the run for the reasons`,
          }, `${fmtCount(qN)} quarantined`)
        : null),
    el("span", { class: `chip runrow__status runrow__status--${r.status}` }, r.status),
    el("span", { class: "runrow__bar", aria: { hidden: "true" } },
      el("span", { class: "runrow__fill", style: { width: pct + "%" } })),
    el("span", { class: "data runrow__nums" }, `${fmtCount(done)}/${fmtCount(total)}`),
    el("span", { class: "data runrow__cost" }, fmtCost(r.cost?.actualUSD ?? 0)),
  );
}

/* ================= preflight ============================================================ */

async function preflightSheet(params, project, instruments, presetInstrument) {
  const s = openSheet({ title: "Preflight", overline: "Cost and privacy check before starting", wide: true });
  const corpora = project.corpora ?? [];
  let instrumentId = presetInstrument ?? instruments[0]?.id ?? null;
  // Default to the MOST RECENTLY CREATED corpus — re-unitized variants
  // ("… · text=<col>") append to project.corpora, so the latest re-unitization
  // is what a new run reads unless the researcher picks otherwise here.
  let corpusId = corpora.at(-1)?.id ?? null;
  let capUSD = null;

  const corpusOf = (id) => corpora.find((c) => c.id === id) ?? null;
  const textColumnOf = (c) => c?.textColumn ?? c?.unitization?.textColumn ?? null;

  const resultHost = el("div", { class: "preflight__result" });
  const startBtn = el("button", { class: "btn btn--primary", type: "button", disabled: true }, "Start the run");

  const instSelect = el("select", { class: "input", "aria-label": "Instrument" },
    ...instruments.map((i) => el("option", { value: i.id, selected: i.id === instrumentId }, `${i.name} (${i.level})`)));
  instSelect.addEventListener("change", () => { instrumentId = instSelect.value; runPreflight(); });

  // Each corpus owns ONE text column — the option says which, so picking the
  // corpus IS picking the column the instrument reads.
  const corpusSelect = el("select", { class: "input", "aria-label": "Corpus — picking a corpus picks the text column the instrument reads" },
    ...corpora.map((c) => el("option", { value: c.id, selected: c.id === corpusId }, scopechip.optionLabel(c, project))));
  const scopeHost = el("div", {});
  const paintScope = () => {
    clear(scopeHost);
    const props = scopechip.fromCorpus(corpusOf(corpusId), project);
    if (props) scopeHost.append(scopechip.render(props));
  };
  corpusSelect.addEventListener("change", () => { corpusId = corpusSelect.value; paintScope(); runPreflight(); });
  paintScope();

  s.body.append(frag(
    el("div", { class: "controlrow" },
      el("label", { class: "controlrow__item controlrow__item--grow" }, el("span", { class: "overline" }, "instrument"), instSelect),
      el("label", { class: "controlrow__item controlrow__item--grow" }, el("span", { class: "overline" }, "corpus"), corpusSelect)),
    corpora.length > 1
      ? el("p", { class: "screen__hint faint" }, "Same instrument, different data: pick the corpus to read.")
      : null,
    scopeHost,
    resultHost,
  ));
  s.foot.append(
    el("button", { class: "btn btn--quiet", type: "button", onclick: () => s.close() }, "Cancel"),
    startBtn,
  );

  async function runPreflight() {
    if (!instrumentId || !corpusId) return;
    startBtn.disabled = true;
    clear(resultHost).append(el("p", { class: "faint", role: "status" }, "estimating…"));
    try {
      // live: {units, calls, inputTokens, outputTokens, estUSD, etaMin,
      //        privacyOk, privacyError?, budget: {capUSD, spentUSD, wouldExceed}}
      const pf = await api.runs.preflight(params.slug, { instrumentId, corpusId });
      clear(resultHost);
      const hasCap = pf.budget && pf.budget.capUSD !== null && pf.budget.capUSD !== undefined;
      const remaining = hasCap ? Math.max(0, pf.budget.capUSD - (pf.budget.spentUSD ?? 0)) : null;
      const capInput = el("input", {
        class: "input input--num", type: "number", step: "0.5", min: 0,
        placeholder: remaining != null ? String(remaining) : "none",
        "aria-label": "Hard cost cap in USD",
        onchange: (e) => { capUSD = e.target.value === "" ? null : Number(e.target.value); },
      });
      const textColumn = textColumnOf(corpusOf(corpusId));
      resultHost.append(
        kvList(
          kv("Scope", el("span", { class: "data" },
            `${fmtCount(pf.units)} units · text from ${textColumn ?? "(column not recorded)"}`),
            el("span", { class: "faint" }, ` → ${fmtCount(pf.calls)} call${pf.calls === 1 ? "" : "s"}`)),
          kv("Tokens", el("span", { class: "data" }, `~${fmtCount(pf.inputTokens)} in · ~${fmtCount(pf.outputTokens)} out`)),
          kv("Estimated cost", el("span", { class: "data preflight__cost" }, fmtCost(pf.estUSD)),
            el("span", { class: "faint" }, " — assumes the full output-token budget; excludes Director second opinions and retries")),
          kv("ETA", el("span", { class: "data" }, fmtDuration(pf.etaMin))),
          kv("Privacy", pf.privacyOk
            ? el("span", { class: "preflight__privacy preflight__privacy--ok" }, "✓ allowed under this project's mode")
            : el("span", { class: "preflight__privacy preflight__privacy--blocked" }, "✕ blocked — ", pf.privacyError ?? "this backend is not allowed under the project's privacy mode")),
          kv("Budget", hasCap
            ? el("span", { class: "data" },
                `${fmtCost(remaining)} remaining of ${fmtCost(pf.budget.capUSD)} cap`,
                pf.budget.wouldExceed ? el("span", { class: "chip chip--signal" }, " would exceed") : null)
            : "no project cap"),
          kv("Hard cap for this run", capInput, el("span", { class: "faint" }, " USD — the run stops at the cap; resuming later continues without re-paying finished units")),
        ),
      );
      startBtn.disabled = !pf.privacyOk;
      startBtn.onclick = async () => {
        startBtn.disabled = true;
        try {
          const { runId } = await api.runs.start(params.slug, { instrumentId, corpusId, capUSD });
          toast.success("Run started.", { detail: runId, data: true });
          await refreshProject(params.slug).catch(() => {});
          s.close();
          router.navigate(`p/${params.slug}/runs/${runId}`);
        } catch (err) {
          startBtn.disabled = false;
          toast.error("The run did not start.", { detail: String(err.message ?? err) });
        }
      };
    } catch (err) {
      clear(resultHost).append(el("p", { class: "faint" }, "Preflight failed: ", String(err.message ?? err)));
    }
  }
  runPreflight();
}

/* ================= detail / live monitor ================================================== */

function renderDetail(mount, params) {
  asyncMount(mount, async () => {
    const project = await ensureProject(params.slug);
    const run = (project.runs ?? []).find((r) => r.id === params.id) ?? { id: params.id, status: "unknown" };
    return { project, run };
  }, ({ project, run }) => {
    // ONLY a running run gets a monitor subscription. A pending or paused run
    // is not executing — the server's monitor stream would answer immediately
    // with its terminal state, and an immediate done + re-render once looped
    // this screen into an endless stack of "Run complete." toasts.
    const live = run.status === "running";
    const instrument = (project.instruments ?? []).find((i) => i.id === run.instrumentId);
    const level = instrument?.level ?? "exploratory";
    const done0 = run.checkpoint?.done ?? 0;
    const total0 = run.checkpoint?.total ?? 0;

    // Start (pending) / Resume (paused/aborted) both ride the resume route:
    // execution is exactly-once off the outputs already on disk.
    const startBtn = (label) => el("button", {
      class: "btn btn--primary", type: "button",
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.runs.resume(params.slug, run.id);
          toast.info(label === "Start" ? "Run started." : "Resumed.", { detail: run.id, data: true });
          await refreshProject(params.slug).catch(() => {});
          window.dispatchEvent(new HashChangeEvent("hashchange")); // re-render into the live monitor
        } catch (err) {
          e.target.disabled = false;
          toast.error(`${label} failed.`, { detail: String(err.message ?? err) });
        }
      },
    }, label);

    const ledeFor = {
      running: "Running. The numbers below update as units finish.",
      pending: "Created but not started — nothing has been read or paid for yet.",
      paused: "Paused. Outputs already on disk are kept; resuming continues from the checkpoint without re-paying.",
      aborted: "Stopped. Outputs already on disk are kept; a resume continues from the checkpoint without re-paying.",
      complete: "Complete. Explore the results, or analyze them in the Workbench — every analysis reads one run's outputs.",
      failed: "Failed — see the warnings below; resuming retries only the unfinished units.",
    };
    // the labeled-data takeaway: GET runs/:r/export.csv — your rows plus the
    // instrument's columns; the server marks partial files in the filename
    const csvBtn = () => el("button", {
      class: "btn", type: "button",
      title: "Your rows back, plus the run's columns: the label under the construct's name, confidence when the model reported one (dictionary runs have none), escalated, an error column when units quarantined, and unit_id.",
      onclick: () => api.runs.exportCsv(params.slug, run.id),
    }, "Download labeled CSV");
    const hasOutputs = (run.checkpoint?.done ?? 0) > 0;
    mount.append(screenHead({
      overline: `Run · ${run.id}`,
      // the run's NAME is the title — renameable in place; legacy runs fall
      // back to the instrument so the title never reads as a bare id
      title: renameable.render({
        value: run.name ?? null,
        fallback: instrument?.name ?? run.instrumentId ?? run.id,
        label: "Rename this run",
        onSave: async (name) => {
          try {
            await api.runs.rename(params.slug, run.id, name);
            run.name = name;
            toast.success("Run renamed.", { detail: name, data: false });
            refreshProject(params.slug).catch(() => {});
          } catch (err) {
            toast.error("Rename failed.", { detail: String(err.message ?? err) });
            throw err;
          }
        },
      }),
      lede: ledeFor[run.status] ?? `Status: ${run.status}.`,
      actions: run.status === "complete"
        ? [
            el("a", { class: "btn btn--primary", href: `#/p/${params.slug}/explore/${run.id}` }, "Explore results"),
            csvBtn(),
            el("a", { class: "btn", href: `#/p/${params.slug}/analyses?runId=${encodeURIComponent(run.id)}` }, "Analyze →"),
            el("a", { class: "btn", href: `#/p/${params.slug}/runs/${run.id}/disagreement` }, "Disagreement"),
            el("a", {
              class: "btn",
              href: run.instrumentId
                ? `#/p/${params.slug}/runs?preflight=${encodeURIComponent(run.instrumentId)}`
                : `#/p/${params.slug}/runs`,
              title: "Start a new run of this instrument on a different corpus — pick the corpus in the preflight.",
            }, "Run on another corpus…"),
          ]
        : run.status === "pending"
          ? [startBtn("Start")]
          : run.status === "paused" || run.status === "aborted" || run.status === "failed"
            ? [startBtn("Resume"), ...(hasOutputs ? [csvBtn()] : [])]
            : [],
    }));

    /* -- context: what this run did, in one line — ran <instrument> on
       <corpus — text: col · units> · measures <construct>. Older records
       missing a relation say so quietly instead of guessing. -- */
    const runCorpus = (project.corpora ?? []).find((c) => c.id === run.corpusId) ?? null;
    const runConstruct = instrument
      ? (project.constructs ?? []).find((c) => c.id === instrument.constructId) ?? null
      : null;
    mount.append(contextLine([
      instrument
        ? { label: "ran", text: instrument.name, href: `#/p/${params.slug}/instruments/${instrument.id}` }
        : { label: "ran", text: run.instrumentId ?? "instrument not recorded", faint: !run.instrumentId },
      { label: "on", text: corpusText(runCorpus, project, run.corpusId), faint: !runCorpus },
      runConstruct
        ? { label: "measures", text: runConstruct.name, href: `#/p/${params.slug}/constructs/${runConstruct.id}` }
        : instrument?.constructId
          ? { label: "measures", text: instrument.constructId }
          : null,
    ]));

    /* -- the persisted failure/pause reason: run.error {code, message}. The
       failed lede says "see the warnings below", so the stored error must
       actually render — both here and in the warnings feed. -- */
    if (run.error) {
      mount.append(el("p", { class: "annotation annotation--still" },
        el("span", { class: "chip chip--signal data" }, String(run.error.code ?? "ERROR")),
        " ", run.error.message ?? "no message recorded",
        run.status === "failed" || run.status === "paused"
          ? el("span", { class: "faint" }, " — Resume retries only the unfinished units; finished outputs are kept.")
          : null));
    }

    /* -- monitor surface -- */
    const progFill = el("span", { class: "monitor__fill", style: { width: total0 ? `${(done0 / total0) * 100}%` : "0%" } });
    const progText = el("span", { class: "data monitor__progresstext" }, `${fmtCount(done0)} / ${fmtCount(total0)}`);
    const costEl = el("span", { class: "monitor__cost data" }, fmtCost(run.cost?.actualUSD ?? 0));
    const escChip = el("button", {
      class: "chip chip--signal monitor__esc", type: "button",
      onclick: () => escHost.scrollIntoView({ behavior: "smooth", block: "start" }),
    }, `${run.escalation?.count ?? 0} escalations`);
    const warnFeed = el("ul", { class: "monitor__warnings", role: "list", aria: { live: "polite" } });
    const distHost = el("div", { class: "monitor__dist" });

    const liveRegion = el("p", { class: "sr-only", role: "status", aria: { live: "polite", atomic: "true" } });

    mount.append(section("Monitor",
      el("div", { class: "monitor" },
        el("div", { class: "monitor__progress" },
          el("span", { class: "monitor__track", aria: { hidden: "true" } }, progFill),
          progText),
        el("div", { class: "monitor__row" },
          el("span", { class: "overline" }, "running cost"), costEl,
          el("span", { class: "overline" }, "escalations"), escChip,
          controlButtons()),
        el("p", { class: "faint monitor__costnote" },
          "Cost meters every worker attempt that returns a token count, including failed and repaired attempts; attempts that error before returning one are billed by the provider but not meterable. Director second opinions are excluded here and count toward the project budget."),
        liveRegion,
        el("div", { class: "monitor__cols" },
          el("div", { class: "monitor__distwrap" },
            el("h4", { class: "overline" }, "Label distribution"),
            live ? el("p", { class: "faint" }, "updates as units finish") : null,
            distHost),
          el("div", { class: "monitor__warnwrap" },
            el("h4", { class: "overline" }, "Warnings"),
            warnFeed)))));

    let distChart = null;
    const paintDist = (labelDist) => {
      // labelDist arrives through monitor ticks while the run executes; the
      // run record also persists it at checkpoints and completion, so cold
      // (non-live) views paint the stored distribution below
      const entries = Object.entries(labelDist ?? {});
      if (!entries.length) return;
      const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
      const data = entries.map(([label, v]) => ({ label, value: v / total, level }));
      if (!distChart) {
        clear(distHost);
        distChart = bar.render(distHost, data, { format: (v) => fmtStat(v), labelWidth: 120, valueWidth: 64 });
      } else {
        distChart.update(data);
      }
    };
    // the persisted distribution (checkpointed by the engine) paints first
    // for non-live views; the status line under it states what it means
    if (!live && Object.keys(run.labelDist ?? {}).length) paintDist(run.labelDist);
    if (run.status === "complete") {
      distHost.append(el("p", { class: "faint" },
        "Finished — drill into the distribution in ",
        el("a", { href: `#/p/${params.slug}/explore/${run.id}` }, "Explore results"), "."));
    } else if (run.status === "paused" || run.status === "aborted" || run.status === "failed") {
      distHost.append(el("p", { class: "faint" }, "Partial — resume to continue; outputs so far are kept."));
    } else if (!live) {
      distHost.append(el("p", { class: "faint" }, "Empty until the run starts — labels appear here as units finish."));
    }

    // live warning entries are {kind, message, unitId?} objects; the none-line
    // leaves the moment a real warning lands
    const seenWarnings = new Set();
    const noWarningsLine = el("li", { class: "monitor__warning monitor__warning--none faint" },
      "No warnings. A label taking over the distribution (degenerate output) is flagged here; drift is flagged when sampled agreement drops more than 0.15 below the certificate (checked every 2,000 outputs on up to 20 gold units).");
    const pushWarnings = (warnings = []) => {
      for (const w of warnings) {
        const text = typeof w === "string" ? w : w?.message ?? JSON.stringify(w);
        if (seenWarnings.has(text)) continue;
        seenWarnings.add(text);
        noWarningsLine.remove();
        warnFeed.append(el("li", { class: "monitor__warning" },
          el("span", { class: "chip chip--signal" }, typeof w === "object" && w?.kind ? w.kind : "watch"),
          el("span", {}, text)));
      }
      if (!warnFeed.children.length) {
        warnFeed.append(noWarningsLine);
      }
    };
    // a failed/paused run's persisted error opens the feed — the lede points here
    pushWarnings(run.error
      ? [{ kind: String(run.error.code ?? "error"), message: run.error.message ?? "no message recorded" }]
      : []);

    if (live) {
      monitor?.close?.();
      monitor = api.runs.monitor(params.slug, run.id, {
        onTick(t) {
          progFill.style.width = `${(t.done / t.total) * 100}%`;
          progText.textContent = `${fmtCount(t.done)} / ${fmtCount(t.total)}`;
          costEl.textContent = fmtCost(t.costUSD);
          if (t.escalations !== undefined) escChip.textContent = `${t.escalations} escalation${t.escalations === 1 ? "" : "s"}`;
          paintDist(t.labelDist);
          pushWarnings(t.warnings);
          liveRegion.textContent = `${t.done} of ${t.total} units, ${fmtCost(t.costUSD)}`;
        },
        async onDone(data) {
          // Status-aware: the stream also settles on pause/abort/failure, and
          // those already announce themselves at the button that caused them.
          monitor?.close?.();
          monitor = null;
          const status = data?.status ?? "complete";
          if (status === "complete") {
            toast.success("Run complete.", { detail: `${run.id} — explore the results`, data: true });
          } else if (status === "failed") {
            toast.error("Run failed.", { detail: `${run.id} — open it for the error; resume retries unfinished units`, data: true });
          }
          // Loop guard on the REFRESHED disk status: refetch first, then
          // re-render only when the STORED record actually moved off the
          // status this screen rendered. Guarding on the stream's status
          // alone looped forever when the stream said "failed" but the disk
          // record had never settled — every re-render re-subscribed and
          // replayed the same done event.
          const fresh = await refreshProject(params.slug).catch(() => null);
          const freshStatus = (fresh?.runs ?? []).find((r) => r.id === run.id)?.status ?? run.status;
          if (freshStatus === run.status) {
            liveRegion.textContent = `The monitor stream ended (${status}) while the stored run still reads "${run.status}".`;
            pushWarnings([{ kind: "monitor", message: `Stream ended (${status}) but the stored status is still ${run.status} — reload the page to reconnect.` }]);
            return;
          }
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        },
        onError(err) {
          toast.error("Monitor stream dropped.", { detail: String(err.message ?? err) });
        },
      });
    }

    /* -- escalations: output LINES with escalated: true. The line keeps the
       worker's juror hash; a Director override replaces label/rationale in
       place and marks escalatedBy: "director"; a Director that reviewed and
       agreed marks escalatedBy: "director-concurred" (engine provenance).
       Without a Director configured (run.escalation.directorModel null) the
       predicate still flags units — but NO second opinion ever ran, and the
       copy must not imply one did. -- */
    const hasDirector = Boolean(run.escalation?.directorModel);
    const escHost = el("div", {});
    mount.append(section("Escalation queue", escHost));
    api.runs.escalations(params.slug, run.id)
      .then((escalations) => {
        if (!escalations?.length) {
          escHost.append(el("p", { class: "faint" }, hasDirector
            ? "No escalations. Low-confidence, high-entropy, repaired, and oddly long units queue here for the Director's second opinion."
            : "No escalations. Low-confidence, high-entropy, repaired, and oddly long units are flagged here; no Director is configured, so no second opinion would run."));
          return;
        }
        escChip.textContent = `${escalations.length} escalation${escalations.length === 1 ? "" : "s"}`;
        if (!hasDirector) {
          escHost.append(el("p", { class: "screen__hint faint" },
            "Flagged by the predicate (low confidence / high entropy / repaired / unusually long); no Director is configured, so no second opinion ran. Review these units yourself."));
        }
        for (const esc of escalations) {
          const overridden = esc.escalatedBy === "director";
          const concurred = esc.escalatedBy === "director-concurred";
          escHost.append(el("div", { class: "escrow" },
            el("button", {
              class: "refchip data evidence-door escrow__unit", type: "button",
              dataset: { evidence: esc.unitId },
            }, esc.unitId),
            el("div", { class: "escrow__side" },
              el("p", { class: "escrow__who data" },
                String(esc.juror ?? "").slice(0, 12),
                overridden
                  ? el("span", { class: "chip chip--machine" }, "Director override ✦")
                  : concurred
                    ? el("span", { class: "chip chip--ghost" }, "worker verdict stands (Director concurred)")
                    : el("span", { class: "chip chip--ghost" }, "flagged — no second opinion recorded")),
              el("p", {}, el("span", { class: "chip chip--machine" }, String(esc.label)),
                esc.confidence !== undefined ? el("span", { class: "data faint" }, ` conf ${fmtStat(esc.confidence)}`) : null),
              esc.rationale ? el("p", { class: "escrow__rationale" }, esc.rationale) : null),
          ));
        }
      })
      .catch(() => escHost.append(el("p", { class: "faint" }, "Escalations unavailable.")));

    /* -- quarantined: units that produced NO valid output after the repair
       budget — recorded with their reason ({unitId, code, message}; older
       records carry bare ids), never silently dropped. -- */
    const quarantined = normalizeQuarantine(run.quarantine);
    const qHost = el("div", {});
    if (quarantined.length) {
      qHost.append(el("p", { class: "screen__hint faint" },
        "These units produced no valid output — schema failure, refusal, or truncation, even after automatic repairs. They carry no label and are excluded from results and the label distribution; they count toward progress."));
      for (const q of quarantined) {
        qHost.append(el("div", { class: "quarrow" },
          q.unitId
            ? el("button", { class: "refchip data evidence-door quarrow__unit", type: "button", dataset: { evidence: q.unitId } }, q.unitId)
            : el("span", { class: "data faint" }, "(unit id missing)"),
          el("span", { class: "quarrow__reason" },
            q.code ? el("span", { class: "chip chip--signal data" }, q.code) : null,
            q.message ?? (q.code ? null : el("span", { class: "faint" }, "no reason recorded — this run predates quarantine reasons")))));
      }
    } else {
      qHost.append(el("p", { class: "faint" },
        "Nothing quarantined. Units whose output fails schema validation, gets refused, or truncates after repairs would be listed here with the reason."));
    }
    mount.append(section(quarantined.length ? `Quarantined · ${fmtCount(quarantined.length)}` : "Quarantined", qHost));

    /* -- record -- */
    mount.append(section("Record", kvList(
      kv("Instrument", el("span", { class: "data" }, run.instrumentId ?? "—"), " ", ladderC.render({ level, size: "sm" })),
      kv("Model", el("span", { class: "data" }, [run.provider, run.model].filter(Boolean).join(" · ") || "—"),
        run.pinned !== undefined ? el("span", { class: "chip chip--ghost" }, run.pinned ? "pinned" : "unpinned — noted in the methods export") : null),
      kv("Estimate", el("span", { class: "data" }, fmtCost(run.cost?.estUSD ?? 0)), el("span", { class: "faint" }, " preflight")),
      kv("Started", run.startedAt ? fmtDateTime(run.startedAt) : "—"),
      kv("Finished", run.finishedAt ? fmtDateTime(run.finishedAt) : "—"),
    )));

    function controlButtons() {
      // Pause/Abort only make sense while the engine is actually executing;
      // pending/paused/aborted get Start/Resume in the header instead.
      if (!live) return null;
      const wrap = el("span", { class: "monitor__controls" });
      const pauseBtn = el("button", {
        class: "btn", type: "button",
        onclick: async () => {
          try {
            await api.runs.pause(params.slug, run.id);
            toast.info("Paused — outputs already paid for are kept.", { data: true });
            await refreshProject(params.slug).catch(() => {});
            window.dispatchEvent(new HashChangeEvent("hashchange")); // re-render into the paused view (Resume in header)
          } catch (err) { toast.error("Pause failed.", { detail: String(err.message ?? err) }); }
        },
      }, "Pause");
      const abortBtn = el("button", {
        class: "btn btn--quiet", type: "button",
        onclick: async () => {
          try {
            await api.runs.abort(params.slug, run.id);
            monitor?.close?.();
            monitor = null;
            toast.warn("Aborted.", { detail: "progress is saved — Resume continues from here without re-paying finished units" });
            await refreshProject(params.slug).catch(() => {});
            window.dispatchEvent(new HashChangeEvent("hashchange"));
          } catch (err) { toast.error("Abort failed.", { detail: String(err.message ?? err) }); }
        },
      }, "Abort");
      wrap.append(pauseBtn, abortBtn);
      return wrap;
    }
  }, "Opening the run…");

  return {
    el: mount,
    destroy() {
      monitor?.close?.();
      monitor = null;
    },
  };
}
