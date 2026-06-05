// Runs — #/p/:slug/runs[/:id] — the measurement actually happening. The list
// opens into a preflight sheet (units × calls → tokens → dollars ±15%, ETA,
// privacy check, budget remaining, hard cap) with ONE start button. A running
// run gets the live monitor: progress rule, running cost in mono, label
// distribution accumulating as mini-bars, a warnings feed, the escalation
// queue, and pause/resume/abort. Completed runs hand off to the Explorer.

import { el, clear } from "../dom.js";
import api from "../api.js";
import * as router from "../router.js";
import * as toast from "../components/toast.js";
import * as ladderC from "../components/ladder.js";
import * as bar from "../components/charts/bar.js";
import { fmtCost, fmtCount, fmtStat, fmtDuration, fmtDateTime } from "../format.js";
import { screenHead, section, asyncMount, ensureProject, refreshProject, emptyState, openSheet, kv, kvList } from "./_shared.js";

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
      title: "Measurement, metered.",
      lede: "Every run states its price before it starts and its cost while it goes. Checkpointed — a crash resumes, never repays.",
      actions: [
        el("button", {
          class: "btn btn--primary", type: "button",
          onclick: () => preflightSheet(params, project, instruments, query.preflight),
        }, "New run…"),
      ],
    }));

    if (!runs.length) {
      mount.append(emptyState({
        title: "Nothing has been measured yet.",
        body: "Pick an instrument, preflight the cost, and let it read the corpus.",
        actions: [el("button", { class: "btn btn--primary", type: "button", onclick: () => preflightSheet(params, project, instruments, query.preflight) }, "Preflight a run")],
      }));
    } else {
      // live run record: progress under checkpoint {done, total}; cost under
      // cost {estUSD, actualUSD, inputTokens, outputTokens}
      const list = el("div", { class: "runlist" });
      for (const r of runs) {
        const done = r.checkpoint?.done ?? 0;
        const total = r.checkpoint?.total ?? 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        list.append(el("a", { class: "runrow", href: `#/p/${params.slug}/runs/${r.id}` },
          el("span", { class: "runrow__id data" }, r.id),
          el("span", { class: "runrow__inst" }, instrumentName(instruments, r.instrumentId)),
          el("span", { class: `chip runrow__status runrow__status--${r.status}` }, r.status),
          el("span", { class: "runrow__bar", aria: { hidden: "true" } },
            el("span", { class: "runrow__fill", style: { width: pct + "%" } })),
          el("span", { class: "data runrow__nums" }, `${fmtCount(done)}/${fmtCount(total)}`),
          el("span", { class: "data runrow__cost" }, fmtCost(r.cost?.actualUSD ?? 0)),
        ));
      }
      mount.append(section("All runs", list));
    }

    if (query.preflight) preflightSheet(params, project, instruments, query.preflight);
  }, "Listing runs…");
}

function instrumentName(instruments, id) {
  return instruments.find((i) => i.id === id)?.name ?? id;
}

/* ================= preflight ============================================================ */

async function preflightSheet(params, project, instruments, presetInstrument) {
  const s = openSheet({ title: "Preflight", overline: "Price before commitment", wide: true });
  let instrumentId = presetInstrument ?? instruments[0]?.id ?? null;
  let corpusId = project.corpora?.[0]?.id ?? null;
  let capUSD = null;

  const resultHost = el("div", { class: "preflight__result" });
  const startBtn = el("button", { class: "btn btn--primary", type: "button", disabled: true }, "Start the run");

  const instSelect = el("select", { class: "input", "aria-label": "Instrument" },
    ...instruments.map((i) => el("option", { value: i.id, selected: i.id === instrumentId }, `${i.name} (${i.level})`)));
  instSelect.addEventListener("change", () => { instrumentId = instSelect.value; runPreflight(); });

  const corpusSelect = el("select", { class: "input", "aria-label": "Corpus" },
    ...(project.corpora ?? []).map((c) => el("option", { value: c.id }, `${c.name} · ${fmtCount(c.unitCount)} units`)));
  corpusSelect.addEventListener("change", () => { corpusId = corpusSelect.value; runPreflight(); });

  s.body.append(
    el("div", { class: "controlrow" },
      el("label", { class: "controlrow__item controlrow__item--grow" }, el("span", { class: "overline" }, "instrument"), instSelect),
      el("label", { class: "controlrow__item controlrow__item--grow" }, el("span", { class: "overline" }, "corpus"), corpusSelect)),
    resultHost,
  );
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
      resultHost.append(
        kvList(
          kv("Scope", el("span", { class: "data" },
            `${fmtCount(pf.units)} units → ${fmtCount(pf.calls)} call${pf.calls === 1 ? "" : "s"}`)),
          kv("Tokens", el("span", { class: "data" }, `~${fmtCount(pf.inputTokens)} in · ~${fmtCount(pf.outputTokens)} out`)),
          kv("Estimated cost", el("span", { class: "data preflight__cost" }, fmtCost(pf.estUSD)),
            el("span", { class: "faint" }, " (±15%)")),
          kv("ETA", el("span", { class: "data" }, fmtDuration(pf.etaMin))),
          kv("Privacy", pf.privacyOk
            ? el("span", { class: "preflight__privacy preflight__privacy--ok" }, "✓ allowed under this project's mode")
            : el("span", { class: "preflight__privacy preflight__privacy--blocked" }, "✕ blocked — ", pf.privacyError ?? "this backend is not allowed under the project's privacy mode")),
          kv("Budget", hasCap
            ? el("span", { class: "data" },
                `${fmtCost(remaining)} remaining of ${fmtCost(pf.budget.capUSD)} cap`,
                pf.budget.wouldExceed ? el("span", { class: "chip chip--signal" }, " would exceed") : null)
            : "no project cap"),
          kv("Hard cap for this run", capInput, el("span", { class: "faint" }, " USD — the run aborts cleanly and resumably at the cap")),
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
    const live = run.status === "running" || run.status === "pending" || run.status === "paused";
    const instrument = (project.instruments ?? []).find((i) => i.id === run.instrumentId);
    const level = instrument?.level ?? "exploratory";
    const done0 = run.checkpoint?.done ?? 0;
    const total0 = run.checkpoint?.total ?? 0;

    mount.append(screenHead({
      overline: `Run · ${run.id}`,
      title: instrumentName(project.instruments ?? [], run.instrumentId),
      lede: live ? "Reading now. Numbers below accumulate as outputs land." : `Status: ${run.status}.`,
      actions: run.status === "complete"
        ? [
            el("a", { class: "btn btn--primary", href: `#/p/${params.slug}/explore/${run.id}` }, "Explore results"),
            el("a", { class: "btn", href: `#/p/${params.slug}/runs/${run.id}/disagreement` }, "Disagreement"),
          ]
        : [],
    }));

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
        liveRegion,
        el("div", { class: "monitor__cols" },
          el("div", { class: "monitor__distwrap" },
            el("h4", { class: "overline" }, "Label distribution — accumulating"),
            distHost),
          el("div", { class: "monitor__warnwrap" },
            el("h4", { class: "overline" }, "Warnings"),
            warnFeed)))));

    let distChart = null;
    const paintDist = (labelDist) => {
      // labelDist arrives ONLY through monitor ticks (in-memory telemetry);
      // the persisted run record carries no distribution
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
    distHost.append(el("p", { class: "faint" },
      live ? "accumulates as outputs land…" : "label distributions live in the run's outputs — explore the results for the full read"));

    // live warning entries are {kind, message, unitId?} objects
    const seenWarnings = new Set();
    const pushWarnings = (warnings = []) => {
      for (const w of warnings) {
        const text = typeof w === "string" ? w : w?.message ?? JSON.stringify(w);
        if (seenWarnings.has(text)) continue;
        seenWarnings.add(text);
        warnFeed.append(el("li", { class: "monitor__warning" },
          el("span", { class: "chip chip--signal" }, typeof w === "object" && w?.kind ? w.kind : "watch"),
          el("span", {}, text)));
      }
      if (!warnFeed.children.length) {
        warnFeed.append(el("li", { class: "monitor__warning monitor__warning--none faint" }, "nothing degenerate, nothing drifting"));
      }
    };
    pushWarnings([]);

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
        onDone() {
          toast.success("Run complete.", { detail: `${run.id} — explore the results`, data: true });
          refreshProject(params.slug).catch(() => {});
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        },
        onError(err) {
          toast.error("Monitor stream dropped.", { detail: String(err.message ?? err) });
        },
      });
    }

    /* -- escalations: output LINES with escalated: true. The line keeps the
       worker's juror hash; a Director override replaces label/rationale in
       place and marks escalatedBy: "director" (escalate.js provenance). -- */
    const escHost = el("div", {});
    mount.append(section("Escalation queue", escHost));
    api.runs.escalations(params.slug, run.id)
      .then((escalations) => {
        if (!escalations?.length) {
          escHost.append(el("p", { class: "faint" }, "No escalations. Low-confidence, high-entropy, repaired, and oddly long units queue here for the Director's second opinion."));
          return;
        }
        escChip.textContent = `${escalations.length} escalation${escalations.length === 1 ? "" : "s"}`;
        for (const esc of escalations) {
          const overridden = esc.escalatedBy === "director";
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
                  : el("span", { class: "chip chip--ghost" }, "worker verdict stands")),
              el("p", {}, el("span", { class: "chip chip--machine" }, String(esc.label)),
                esc.confidence !== undefined ? el("span", { class: "data faint" }, ` conf ${fmtStat(esc.confidence)}`) : null),
              esc.rationale ? el("p", { class: "escrow__rationale" }, esc.rationale) : null),
          ));
        }
      })
      .catch(() => escHost.append(el("p", { class: "faint" }, "Escalations unavailable.")));

    /* -- record -- */
    mount.append(section("Record", kvList(
      kv("Instrument", el("span", { class: "data" }, run.instrumentId ?? "—"), " ", ladderC.render({ level, size: "sm" })),
      kv("Model", el("span", { class: "data" }, [run.provider, run.model].filter(Boolean).join(" · ") || "—"),
        run.pinned !== undefined ? el("span", { class: "chip chip--ghost" }, run.pinned ? "pinned" : "unpinned — stated in methods") : null),
      kv("Estimate", el("span", { class: "data" }, fmtCost(run.cost?.estUSD ?? 0)), el("span", { class: "faint" }, " preflight")),
      kv("Started", run.startedAt ? fmtDateTime(run.startedAt) : "—"),
      kv("Finished", run.finishedAt ? fmtDateTime(run.finishedAt) : "—"),
    )));

    function controlButtons() {
      if (!live) return null;
      const wrap = el("span", { class: "monitor__controls" });
      const pauseBtn = el("button", {
        class: "btn", type: "button",
        onclick: async () => {
          const paused = pauseBtn.dataset.state === "paused";
          try {
            if (paused) { await api.runs.resume(params.slug, run.id); pauseBtn.dataset.state = ""; pauseBtn.textContent = "Pause"; toast.info("Resumed."); }
            else { await api.runs.pause(params.slug, run.id); pauseBtn.dataset.state = "paused"; pauseBtn.textContent = "Resume"; toast.info("Paused — outputs already paid for are kept."); }
          } catch (err) { toast.error("Control failed.", { detail: String(err.message ?? err) }); }
        },
      }, run.status === "paused" ? "Resume" : "Pause");
      if (run.status === "paused") pauseBtn.dataset.state = "paused";
      const abortBtn = el("button", {
        class: "btn btn--quiet", type: "button",
        onclick: async () => {
          try {
            await api.runs.abort(params.slug, run.id);
            monitor?.close?.();
            toast.warn("Aborted.", { detail: "checkpointed — a future run resumes from here, cached calls stay free" });
            refreshProject(params.slug).catch(() => {});
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
