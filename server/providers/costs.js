// Cost metering: preflight estimates, a running accumulator, and the hard
// budget gate. Token heuristic everywhere: chars / 3.6.
import { ConcordError } from "../core/errors.js";

const CHARS_PER_TOKEN = 3.6;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

const usd = (inputTokens, outputTokens, pricing = {}) =>
  (inputTokens / 1e6) * (pricing.inUSDper1M ?? 0) +
  (outputTokens / 1e6) * (pricing.outUSDper1M ?? 0);

// Preflight estimate for a run: every call sends the prompt template plus one
// unit, and may emit up to maxTokens.
export function estimateRun({
  units,
  template = "",
  maxTokens = 256,
  pricing = { inUSDper1M: 0, outUSDper1M: 0 },
  callsPerUnit = 1,
  secondsPerCall = 1.2,
  concurrency = 4,
}) {
  const texts = (units ?? []).map((u) => (typeof u === "string" ? u : (u?.text ?? "")));
  const calls = texts.length * callsPerUnit;
  const meanUnitChars = texts.length ? texts.reduce((n, t) => n + t.length, 0) / texts.length : 0;
  const inputTokens = Math.round((calls * (template.length + meanUnitChars)) / CHARS_PER_TOKEN);
  const outputTokens = calls * maxTokens;
  return {
    calls,
    inputTokens,
    outputTokens,
    estUSD: round6(usd(inputTokens, outputTokens, pricing)),
    etaMinutes: Math.round(((calls * secondsPerCall) / Math.max(1, concurrency) / 60) * 10) / 10,
  };
}

// Running accumulator. add(usage, pricing) → current totals snapshot.
export function meter() {
  const totals = { inputTokens: 0, outputTokens: 0, usd: 0 };
  return {
    add(usage, pricing) {
      const inT = usage?.inputTokens ?? 0;
      const outT = usage?.outputTokens ?? 0;
      totals.inputTokens += inT;
      totals.outputTokens += outT;
      totals.usd = round6(totals.usd + usd(inT, outT, pricing));
      return { ...totals };
    },
    totals() {
      return { ...totals };
    },
  };
}

// Hard cap: at/over budget aborts the run (cleanly and resumably, per design).
export function checkBudget(spentUSD, capUSD) {
  if (capUSD == null) return;
  if (spentUSD >= capUSD) {
    throw new ConcordError(
      "BUDGET_EXCEEDED",
      `spent $${spentUSD.toFixed(4)} ≥ budget cap $${capUSD.toFixed(2)}`,
      {
        spentUSD,
        capUSD,
      },
    );
  }
}
