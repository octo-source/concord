// Task F — panel aggregation tests. Pure functions, hand-checked numbers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregate, entropy } from "../../server/instruments/panel.js";
import { ConcordError } from "../../server/core/errors.js";

const payload = (aggregation, extra = {}) => ({ jurors: [], aggregation, ...extra });

const outs = (...pairs) =>
  pairs.map(([juror, label, confidence]) =>
    confidence === undefined ? { juror, label } : { juror, label, confidence },
  );

// ---------------------------------------------------------------- majority

test("majority: clear modal label wins", () => {
  const r = aggregate(outs(["a", "pay"], ["b", "pay"], ["c", "workload"]), payload("majority"));
  assert.equal(r.label, "pay");
  assert.ok(!r.flagged);
});

test("majority: tie → flagged, no label", () => {
  const r = aggregate(outs(["a", "pay"], ["b", "workload"]), payload("majority"));
  assert.equal(r.flagged, true);
  assert.equal(r.label, undefined);
});

test("majority: numeric labels keep their type", () => {
  const r = aggregate(outs(["a", 3], ["b", 3], ["c", 4]), payload("majority"));
  assert.strictEqual(r.label, 3);
});

// ---------------------------------------------------------------- mean / median

test("mean: numeric labels averaged; numeric strings accepted", () => {
  const r = aggregate(outs(["a", 2], ["b", "4"], ["c", 3]), payload("mean"));
  assert.equal(r.label, 3);
});

test("median: odd count → middle; even count → average of middle two", () => {
  assert.equal(aggregate(outs(["a", 1], ["b", 5], ["c", 2]), payload("median")).label, 2);
  assert.equal(aggregate(outs(["a", 1], ["b", 2], ["c", 4], ["d", 8]), payload("median")).label, 3);
});

test("mean/median: non-numeric labels throw VALIDATION", () => {
  for (const rule of ["mean", "median"]) {
    assert.throws(
      () => aggregate(outs(["a", "pay"], ["b", "pay"]), payload(rule)),
      (e) => e instanceof ConcordError && e.code === "VALIDATION",
    );
  }
});

test("mean/median: multilabel arrays rejected", () => {
  assert.throws(
    () => aggregate(outs(["a", ["pay"]], ["b", ["pay"]]), payload("mean")),
    (e) => e.code === "VALIDATION",
  );
});

// ---------------------------------------------------------------- unanimityOrFlag

test("unanimityOrFlag: unanimous → label; any dissent → flagged", () => {
  assert.equal(
    aggregate(outs(["a", "yes"], ["b", "yes"], ["c", "yes"]), payload("unanimityOrFlag")).label,
    "yes",
  );
  const r = aggregate(outs(["a", "yes"], ["b", "yes"], ["c", "no"]), payload("unanimityOrFlag"));
  assert.equal(r.flagged, true);
  assert.equal(r.label, undefined);
});

test("unanimityOrFlag: multilabel compares whole SETS order-insensitively", () => {
  const r = aggregate(
    outs(["a", ["pay", "growth"]], ["b", ["growth", "pay"]]),
    payload("unanimityOrFlag"),
  );
  assert.deepEqual(r.label, ["pay", "growth"]);
  const f = aggregate(outs(["a", ["pay"]], ["b", ["pay", "growth"]]), payload("unanimityOrFlag"));
  assert.equal(f.flagged, true);
});

// ---------------------------------------------------------------- confidenceWeighted

test("confidenceWeighted: high-confidence minority outweighs low-confidence majority", () => {
  // yes: 0.9; no: 0.3 + 0.3 = 0.6 → yes wins despite 2-1 headcount
  const r = aggregate(
    outs(["a", "yes", 0.9], ["b", "no", 0.3], ["c", "no", 0.3]),
    payload("confidenceWeighted"),
  );
  assert.equal(r.label, "yes");
});

test("confidenceWeighted: absent confidence counts as 0.5", () => {
  // yes: 0.5 (absent) + 0.2 = 0.7; no: 0.6 → yes wins only because absent = 0.5
  const r = aggregate(
    outs(["a", "yes"], ["b", "yes", 0.2], ["c", "no", 0.6]),
    payload("confidenceWeighted"),
  );
  assert.equal(r.label, "yes");
});

test("confidenceWeighted: exact weight tie → flagged", () => {
  const r = aggregate(outs(["a", "yes", 0.6], ["b", "no", 0.6]), payload("confidenceWeighted"));
  assert.equal(r.flagged, true);
});

// ---------------------------------------------------------------- reliabilityWeighted

test("reliabilityWeighted: weights keyed by juror version hash decide the vote", () => {
  const weights = { a: 0.9, b: 0.2, c: 0.2 };
  const r = aggregate(
    outs(["a", "yes"], ["b", "no"], ["c", "no"]),
    payload("reliabilityWeighted"),
    weights,
  );
  assert.equal(r.label, "yes"); // 0.9 > 0.4
});

test("reliabilityWeighted: weights fall back to panelPayload.weights; missing juror defaults to 1", () => {
  const p = payload("reliabilityWeighted", { weights: { a: 3 } });
  const r = aggregate(outs(["a", "yes"], ["b", "no"], ["c", "no"]), p);
  assert.equal(r.label, "yes"); // 3 vs 1+1
});

test("reliabilityWeighted: negative weight throws VALIDATION", () => {
  assert.throws(
    () =>
      aggregate(outs(["a", "yes"], ["b", "no"]), payload("reliabilityWeighted"), { a: -1, b: 1 }),
    (e) => e.code === "VALIDATION",
  );
});

// ---------------------------------------------------------------- multilabel voting

test("multilabel majority: per-label strict majority; exactly half excluded", () => {
  const r = aggregate(
    outs(
      ["a", ["pay", "growth"]],
      ["b", ["pay"]],
      ["c", ["pay", "remote"]],
      ["d", ["growth", "remote"]],
    ),
    payload("majority"),
  );
  // pay 3/4 → in; growth 2/4 = exactly half → out; remote 2/4 → out
  assert.deepEqual(r.label, ["pay"]);
  assert.ok(!r.flagged);
});

test("multilabel confidenceWeighted: weights apply per label", () => {
  const r = aggregate(
    outs(["a", ["pay"], 0.9], ["b", ["growth"], 0.2], ["c", ["growth"], 0.2]),
    payload("confidenceWeighted"),
  );
  // total weight 1.3; pay 0.9 > 0.65 in; growth 0.4 < 0.65 out
  assert.deepEqual(r.label, ["pay"]);
});

test("multilabel: empty aggregate set is a valid verdict", () => {
  const r = aggregate(
    outs(["a", ["pay"]], ["b", ["growth"]], ["c", ["remote"]]),
    payload("majority"),
  );
  assert.deepEqual(r.label, []);
});

// ---------------------------------------------------------------- entropy

test("entropy: 2 jurors split → exactly 1.0 (ln2/ln2)", () => {
  assert.equal(entropy(["yes", "no"]), 1);
  const r = aggregate(outs(["a", "yes"], ["b", "no"]), payload("majority"));
  assert.equal(r.entropy, 1);
});

test("entropy: unanimous → 0", () => {
  assert.equal(entropy(["yes", "yes", "yes"]), 0);
  assert.equal(aggregate(outs(["a", "x"], ["b", "x"], ["c", "x"]), payload("majority")).entropy, 0);
});

test("entropy: 3 jurors 2-1 split → hand-checked value", () => {
  // H = -(2/3)ln(2/3) - (1/3)ln(1/3), normalized by ln 2
  const expected = (-(2 / 3) * Math.log(2 / 3) - (1 / 3) * Math.log(1 / 3)) / Math.log(2);
  const got = aggregate(outs(["a", "yes"], ["b", "yes"], ["c", "no"]), payload("majority")).entropy;
  assert.ok(Math.abs(got - expected) < 1e-12);
  assert.ok(Math.abs(got - 0.9182958340544896) < 1e-9); // ≈ 0.918
});

test("entropy: 3-way split over 3 jurors → 1.0; multilabel uses set signatures", () => {
  assert.equal(entropy(["a", "b", "c"]), 1);
  assert.equal(
    entropy([
      ["pay", "growth"],
      ["growth", "pay"],
    ]),
    0,
  ); // same set
  assert.equal(entropy([["pay"], ["growth"]]), 1);
});

// ---------------------------------------------------------------- perJuror + inputs

test("perJuror echoes juror, label, confidence, and the weight the rule used", () => {
  const r = aggregate(outs(["a", "yes", 0.8], ["b", "no"]), payload("confidenceWeighted"));
  assert.deepEqual(r.perJuror, [
    { juror: "a", label: "yes", confidence: 0.8, weight: 0.8 },
    { juror: "b", label: "no", confidence: null, weight: 0.5 },
  ]);
});

test("aggregate accepts a Record<juror, output> as well as an array", () => {
  const r = aggregate(
    { a: { label: "pay" }, b: { label: "pay" }, c: { label: "workload" } },
    payload("majority"),
  );
  assert.equal(r.label, "pay");
  assert.equal(r.perJuror.length, 3);
});

test("input validation: empty panel, duplicate juror, unknown rule, missing label", () => {
  assert.throws(
    () => aggregate([], payload("majority")),
    (e) => e.code === "VALIDATION",
  );
  assert.throws(
    () => aggregate(outs(["a", "x"], ["a", "y"]), payload("majority")),
    (e) => e.code === "VALIDATION",
  );
  assert.throws(
    () => aggregate(outs(["a", "x"]), payload("plurality")),
    (e) => e.code === "VALIDATION",
  );
  assert.throws(
    () => aggregate([{ juror: "a" }], payload("majority")),
    (e) => e.code === "VALIDATION",
  );
});

test("single juror: majority degenerates gracefully (label, entropy 0)", () => {
  const r = aggregate(outs(["a", "yes", 0.9]), payload("majority"));
  assert.equal(r.label, "yes");
  assert.equal(r.entropy, 0);
});
