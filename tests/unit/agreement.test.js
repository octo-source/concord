// Golden-number tests for the agreement module. Every constant below is
// hand-derived from the raw definitions (derivations in comments) before any
// implementation existed. Tolerance 1e-9 unless noted.
import test from "node:test";
import assert from "node:assert/strict";
import {
  percentAgreement,
  cohenKappa,
  krippendorffAlpha,
  gwetAC1,
  gwetAC2,
  perClass,
  confusion,
} from "../../server/stats/agreement.js";
import { bootstrapCI, mcnemar, tostEquivalence } from "../../server/stats/boot.js";
import { ConcordError } from "../../server/core/errors.js";

const EPS = 1e-9;

// Build rows for two coders "A","B" from [valueA, valueB] pairs. null = missing.
function rows2(pairs) {
  const out = [];
  pairs.forEach(([a, b], i) => {
    if (a !== null) out.push({ unitId: `u${i}`, coder: "A", value: a });
    if (b !== null) out.push({ unitId: `u${i}`, coder: "B", value: b });
  });
  return out;
}

// The κ golden table: 20 units, 8 both-yes, 7 both-no, 3 (A yes/B no), 2 (A no/B yes).
function kappaGoldenData() {
  const pairs = [
    ...Array.from({ length: 8 }, () => ["yes", "yes"]),
    ...Array.from({ length: 7 }, () => ["no", "no"]),
    ...Array.from({ length: 3 }, () => ["yes", "no"]),
    ...Array.from({ length: 2 }, () => ["no", "yes"]),
  ];
  return rows2(pairs);
}

// 3-category table for weighted κ: units (1,1),(2,2),(3,3),(1,3), numeric categories.
function weightedKappaData() {
  return rows2([[1, 1], [2, 2], [3, 3], [1, 3]]);
}

test("percentAgreement: κ golden table → 15/20 = 0.75", () => {
  assert.ok(Math.abs(percentAgreement(kappaGoldenData()) - 0.75) < EPS);
});

test("percentAgreement with missing: 3 coders (A,A,B),(A,A,—),(B,B,B) → 7/9", () => {
  // unit1: agreeing pairs Σr(r−1)=2 of m(m−1)=6 → 1/3; unit2: 1; unit3: 1 → mean 7/9
  const data = [
    { unitId: "u1", coder: "c1", value: "A" },
    { unitId: "u1", coder: "c2", value: "A" },
    { unitId: "u1", coder: "c3", value: "B" },
    { unitId: "u2", coder: "c1", value: "A" },
    { unitId: "u2", coder: "c2", value: "A" },
    { unitId: "u3", coder: "c1", value: "B" },
    { unitId: "u3", coder: "c2", value: "B" },
    { unitId: "u3", coder: "c3", value: "B" },
  ];
  assert.ok(Math.abs(percentAgreement(data) - 7 / 9) < EPS);
});

test("cohenKappa golden: po=0.75, pe=0.5 → κ = 0.5 exactly", () => {
  // pA(yes)=11/20, pB(yes)=10/20 → pe = .55*.5 + .45*.5 = 0.5; κ=(.75−.5)/(1−.5)=0.5
  assert.ok(Math.abs(cohenKappa(kappaGoldenData()) - 0.5) < EPS);
});

test("cohenKappa unweighted on 3-cat table → 7/11", () => {
  // po=3/4; pA=[1/2,1/4,1/4], pB=[1/4,1/4,1/2]; pe=1/8+1/16+1/8=5/16
  // κ = (3/4−5/16)/(1−5/16) = (7/16)/(11/16) = 7/11
  assert.ok(Math.abs(cohenKappa(weightedKappaData()) - 7 / 11) < EPS);
});

test("cohenKappa weighted linear on 3-cat table → 0.5 exactly", () => {
  // w_ij = 1−|i−j|/2 → w13=0, w12=w23=1/2. po_w = 3/4 (diagonal only; w13·1=0).
  // pe_w = Σ w_ij pA_i pB_j = 3/16 + 5/32 + 5/32 = 1/2. κw = (3/4−1/2)/(1/2) = 1/2.
  const k = cohenKappa(weightedKappaData(), { weighted: "linear" });
  assert.ok(Math.abs(k - 0.5) < EPS);
});

test("cohenKappa weighted quadratic on 3-cat table → 5/13", () => {
  // w_ij = 1−((i−j)/2)² → w13=0, w12=w23=3/4. po_w = 3/4.
  // pe_w = 7/32 + 13/64 + 11/64 = 19/32. κw = (3/4−19/32)/(1−19/32) = (5/32)/(13/32) = 5/13.
  const k = cohenKappa(weightedKappaData(), { weighted: "quadratic" });
  assert.ok(Math.abs(k - 5 / 13) < EPS);
});

test("cohenKappa weighted quadratic with 2 categories equals unweighted", () => {
  // With k=2 categories |i−j|/(k−1) ∈ {0,1} so weights coincide with nominal.
  // String labels are order-sensitive under weighting → explicit order (C1).
  const data = kappaGoldenData();
  const opts = { weighted: "quadratic", order: ["no", "yes"] };
  assert.ok(Math.abs(cohenKappa(data, opts) - 0.5) < 1e-12);
});

test("gwetAC1 golden: AC1 = 0.25125/0.50125", () => {
  // π̄(yes) = (0.55+0.50)/2 = 0.525; peγ = 2·0.525·0.475 = 0.49875
  // AC1 = (0.75−0.49875)/(1−0.49875) = 0.25125/0.50125 ≈ 0.5012468828
  const want = 0.25125 / 0.50125;
  assert.ok(Math.abs(gwetAC1(kappaGoldenData()) - want) < EPS);
});

test("krippendorffAlpha nominal golden: (A,A),(A,A),(B,B),(A,B) → 8/15", () => {
  // o_AA=4, o_BB=2, o_AB=o_BA=1, n=8, n_A=5, n_B=3
  // D_o = 2/8 = 0.25; D_e = 2·5·3/(8·7) = 30/56; α = 1 − .25/(30/56) = 8/15
  const data = rows2([["A", "A"], ["A", "A"], ["B", "B"], ["A", "B"]]);
  const a = krippendorffAlpha(data, { level: "nominal" });
  assert.ok(Math.abs(a - 8 / 15) < EPS);
});

test("krippendorffAlpha nominal with missing: 3 coders → 0.5625 exactly", () => {
  // unit1 (A,A,B) m=3: o_AA+=1, o_AB+=1, o_BA+=1; unit2 (A,A) m=2: o_AA+=2;
  // unit3 (B,B,B) m=3: o_BB+=3 → n=8, n_A=4, n_B=4, D_o=0.25, D_e=32/56 → α=0.5625
  const data = [
    { unitId: "u1", coder: "c1", value: "A" },
    { unitId: "u1", coder: "c2", value: "A" },
    { unitId: "u1", coder: "c3", value: "B" },
    { unitId: "u2", coder: "c1", value: "A" },
    { unitId: "u2", coder: "c2", value: "A" },
    { unitId: "u3", coder: "c1", value: "B" },
    { unitId: "u3", coder: "c2", value: "B" },
    { unitId: "u3", coder: "c3", value: "B" },
  ];
  const a = krippendorffAlpha(data, { level: "nominal" });
  assert.ok(Math.abs(a - 0.5625) < EPS);
});

test("krippendorffAlpha interval golden: (1,1),(2,3),(4,4) → 52/57", () => {
  // δ²=(c−k)². o_11=2, o_23=o_32=1, o_44=2; n=6; n_1=2,n_2=1,n_3=1,n_4=2
  // D_o = 2/6; D_e = 114/30; α = 1 − (1/3)/(114/30) = 52/57
  const data = rows2([[1, 1], [2, 3], [4, 4]]);
  const a = krippendorffAlpha(data, { level: "interval" });
  assert.ok(Math.abs(a - 52 / 57) < EPS);
});

test("krippendorffAlpha ordinal golden: (1,1),(2,2),(3,3),(1,2) → 0.79 exactly", () => {
  // Coincidence marginals n_1=3, n_2=3, n_3=2, n=8. Ordinal δ²_ck = (Σ_{c≤g≤k} n_g − (n_c+n_k)/2)²:
  // δ²(1,2)=9, δ²(2,3)=6.25, δ²(1,3)=30.25. D_o = (1+1)·9/8 = 2.25.
  // D_e = (162+363+75)/56 = 600/56 = 75/7. α = 1 − 2.25·7/75 = 0.79.
  const data = rows2([[1, 1], [2, 2], [3, 3], [1, 2]]);
  const a = krippendorffAlpha(data, { level: "ordinal" });
  assert.ok(Math.abs(a - 0.79) < EPS);
});

test("property: perfect agreement → κ = α = AC1 = 1", () => {
  const data = rows2([
    ["yes", "yes"], ["no", "no"], ["yes", "yes"], ["no", "no"], ["yes", "yes"],
  ]);
  assert.ok(Math.abs(cohenKappa(data) - 1) < EPS);
  assert.ok(Math.abs(krippendorffAlpha(data, { level: "nominal" }) - 1) < EPS);
  assert.ok(Math.abs(gwetAC1(data) - 1) < EPS);
  assert.ok(Math.abs(percentAgreement(data) - 1) < EPS);
});

test("property: α invariant under coder relabeling and row permutation", () => {
  const base = [
    { unitId: "u1", coder: "c1", value: "A" },
    { unitId: "u1", coder: "c2", value: "A" },
    { unitId: "u1", coder: "c3", value: "B" },
    { unitId: "u2", coder: "c1", value: "A" },
    { unitId: "u2", coder: "c2", value: "A" },
    { unitId: "u3", coder: "c1", value: "B" },
    { unitId: "u3", coder: "c2", value: "B" },
    { unitId: "u3", coder: "c3", value: "B" },
  ];
  const rename = { c1: "r2", c2: "r3", c3: "r1" };
  const permuted = base
    .map((r) => ({ unitId: r.unitId, coder: rename[r.coder], value: r.value }))
    .reverse();
  const a1 = krippendorffAlpha(base, { level: "nominal" });
  const a2 = krippendorffAlpha(permuted, { level: "nominal" });
  assert.ok(Math.abs(a1 - a2) < 1e-12);
  assert.ok(Math.abs(a1 - 0.5625) < EPS);
});

test("property: ordinal α with 2 categories equals nominal α", () => {
  const data = kappaGoldenData(); // values "yes"/"no": two categories
  const nom = krippendorffAlpha(data, { level: "nominal" });
  // string labels are order-sensitive under ordinal level → explicit order (C1);
  // with 2 categories the property holds for either direction of the scale.
  const ord = krippendorffAlpha(data, { level: "ordinal", order: ["no", "yes"] });
  const ordRev = krippendorffAlpha(data, { level: "ordinal", order: ["yes", "no"] });
  assert.ok(Math.abs(nom - ord) < 1e-12);
  assert.ok(Math.abs(ord - ordRev) < 1e-12);
});

test("perClass: hand-derived precision/recall/f1/support", () => {
  // gold: [A,A,B,B,C]; machine m: [A,B,B,B,C]
  // A: P=1, R=1/2, F1=2/3, support 2. B: P=2/3, R=1, F1=4/5, support 2. C: 1,1,1, support 1.
  const data = [];
  const gold = ["A", "A", "B", "B", "C"];
  const m = ["A", "B", "B", "B", "C"];
  gold.forEach((g, i) => {
    data.push({ unitId: `u${i}`, coder: "gold", value: g });
    data.push({ unitId: `u${i}`, coder: "m", value: m[i] });
  });
  const rowsOut = perClass(data, "gold");
  assert.deepEqual(rowsOut.map((r) => r.label), ["A", "B", "C"]);
  const byLabel = Object.fromEntries(rowsOut.map((r) => [r.label, r]));
  assert.ok(Math.abs(byLabel.A.precision - 1) < EPS);
  assert.ok(Math.abs(byLabel.A.recall - 0.5) < EPS);
  assert.ok(Math.abs(byLabel.A.f1 - 2 / 3) < EPS);
  assert.equal(byLabel.A.support, 2);
  assert.ok(Math.abs(byLabel.B.precision - 2 / 3) < EPS);
  assert.ok(Math.abs(byLabel.B.recall - 1) < EPS);
  assert.ok(Math.abs(byLabel.B.f1 - 0.8) < EPS);
  assert.equal(byLabel.B.support, 2);
  assert.ok(Math.abs(byLabel.C.f1 - 1) < EPS);
  assert.equal(byLabel.C.support, 1);
});

test("confusion: rows=A, cols=B, sorted labels", () => {
  const data = [];
  const gold = ["A", "A", "B", "B", "C"];
  const m = ["A", "B", "B", "B", "C"];
  gold.forEach((g, i) => {
    data.push({ unitId: `u${i}`, coder: "gold", value: g });
    data.push({ unitId: `u${i}`, coder: "m", value: m[i] });
  });
  const { labels, matrix } = confusion(data, "gold", "m");
  assert.deepEqual(labels, ["A", "B", "C"]);
  assert.deepEqual(matrix, [
    [1, 1, 0],
    [0, 2, 0],
    [0, 0, 1],
  ]);
});

test("confusion: only jointly coded units count", () => {
  const data = [
    { unitId: "u1", coder: "A", value: "x" },
    { unitId: "u1", coder: "B", value: "x" },
    { unitId: "u2", coder: "A", value: "y" }, // B missing → excluded
  ];
  const { labels, matrix } = confusion(data, "A", "B");
  assert.deepEqual(labels, ["x"]);
  assert.deepEqual(matrix, [[1]]);
});

// ---------- C1: explicit `order` for ordinal/weighted statistics ----------
//
// Ordinal α and weighted κ depend on the CATEGORY SCALE ORDER. For string
// labels the old code silently used alphabetical order, which is wrong for
// scales like low/medium/high (alphabetical: high < low < medium). The
// reviewer demonstrated the bug with ordinal α = 0.3397 (correct numeric
// coding) vs 0.6286 (alphabetical strings) on one dataset; their exact
// dataset is not recoverable from the two rounded numbers, so the golden
// below is an equivalent hand-derived demonstration with the same failure
// direction (alphabetical order inflates α).

// Demonstration dataset, 2 coders, hand-derived:
//   units: (low,high), (low,high), (high,high), (low,low), (medium,medium)
//   coincidence: o_lh = o_hl = 2, o_hh = 2, o_ll = 2, o_mm = 2 → n = 10
//   margins: low 4, medium 2, high 4
// TRUE order (low, medium, high) → margins [4,2,4]:
//   δ²(low,med)  = ((4+2)/2)² = 9
//   δ²(med,high) = ((2+4)/2)² = 9
//   δ²(low,high) = (4+2+4 − (4+4)/2)² = 6² = 36
//   D_o = (o_lh+o_hl)·36/10 = 4·36/10 = 14.4
//   D_e = [2·4·2·9 + 2·2·4·9 + 2·4·4·36]/(10·9) = 1440/90 = 16
//   α = 1 − 14.4/16 = 0.1
// ALPHABETICAL order (high, low, medium) → margins [4,4,2]:
//   δ²(high,low) = ((4+4)/2)² = 16 → D_o = 4·16/10 = 6.4
//   δ²(low,med)  = ((4+2)/2)² = 9, δ²(high,med) = (10−3)² = 49
//   D_e = [2·4·4·16 + 2·4·2·9 + 2·4·2·49]/90 = 1440/90 = 16
//   α = 1 − 6.4/16 = 0.6  ← silently inflated by the old behavior
function ordinalStringDemo(mapFn = (v) => v) {
  return rows2([
    [mapFn("low"), mapFn("high")],
    [mapFn("low"), mapFn("high")],
    [mapFn("high"), mapFn("high")],
    [mapFn("low"), mapFn("low")],
    [mapFn("medium"), mapFn("medium")],
  ]);
}
const LMH = { low: 1, medium: 2, high: 3 };

test("C1: ordinal α with string labels and no order throws E_STAT_INPUT", () => {
  assert.throws(
    () => krippendorffAlpha(ordinalStringDemo(), { level: "ordinal" }),
    (err) =>
      err instanceof ConcordError &&
      err.code === "E_STAT_INPUT" &&
      /order/.test(err.message) &&
      /non-numeric/.test(err.message)
  );
});

test("C1: weighted κ with string labels and no order throws E_STAT_INPUT", () => {
  const data = rows2([["low", "low"], ["medium", "medium"], ["high", "high"], ["low", "high"]]);
  assert.throws(
    () => cohenKappa(data, { weighted: "linear" }),
    (err) => err instanceof ConcordError && err.code === "E_STAT_INPUT" && /order/.test(err.message)
  );
});

test("C1: ordinal α with order — hand-derived golden 0.1, not the alphabetical 0.6", () => {
  const a = krippendorffAlpha(ordinalStringDemo(), {
    level: "ordinal",
    order: ["low", "medium", "high"],
  });
  assert.ok(Math.abs(a - 0.1) < EPS, `α = ${a}, want 0.1`);
});

test("C1: ordinal α recode invariance — string+order EXACTLY equals numeric recode", () => {
  const aStr = krippendorffAlpha(ordinalStringDemo(), {
    level: "ordinal",
    order: ["low", "medium", "high"],
  });
  const aNum = krippendorffAlpha(ordinalStringDemo((v) => LMH[v]), { level: "ordinal" });
  assert.equal(aStr, aNum);
});

test("C1: weighted κ recode invariance — string+order EXACTLY equals numeric recode", () => {
  const strData = rows2([["low", "low"], ["medium", "medium"], ["high", "high"], ["low", "high"]]);
  for (const weighted of ["linear", "quadratic"]) {
    const kStr = cohenKappa(strData, { weighted, order: ["low", "medium", "high"] });
    const kNum = cohenKappa(weightedKappaData(), { weighted });
    assert.equal(kStr, kNum, `${weighted}: ${kStr} vs ${kNum}`);
  }
  // and the linear value is the hand-derived 0.5 from the numeric golden above
  assert.ok(
    Math.abs(cohenKappa(strData, { weighted: "linear", order: ["low", "medium", "high"] }) - 0.5) < EPS
  );
});

test("C1: numeric labels keep working without order (existing goldens unchanged)", () => {
  const a = krippendorffAlpha(rows2([[1, 1], [2, 2], [3, 3], [1, 2]]), { level: "ordinal" });
  assert.ok(Math.abs(a - 0.79) < EPS);
  const k = cohenKappa(weightedKappaData(), { weighted: "linear" });
  assert.ok(Math.abs(k - 0.5) < EPS);
});

test("C1: order must cover every observed category; duplicates rejected", () => {
  assertThrowsCode(
    () =>
      krippendorffAlpha(ordinalStringDemo(), { level: "ordinal", order: ["low", "medium"] }),
    "E_STAT_INPUT"
  );
  assertThrowsCode(
    () =>
      krippendorffAlpha(ordinalStringDemo(), {
        level: "ordinal",
        order: ["low", "low", "medium", "high"],
      }),
    "E_STAT_INPUT"
  );
});

test("C1: interval α with string labels uses order indices as the scale", () => {
  // order indices 0,1,2 ↔ numeric recode 1,2,3 shifted by 1 — interval δ² is
  // translation-invariant, so the two must agree exactly.
  const data = rows2([["lo", "lo"], ["mid", "hi"], ["hi", "hi"]]);
  const aStr = krippendorffAlpha(data, { level: "interval", order: ["lo", "mid", "hi"] });
  const num = rows2([[0, 0], [1, 2], [2, 2]]);
  const aNum = krippendorffAlpha(num, { level: "interval" });
  assert.equal(aStr, aNum);
});

// ---------- R2: Gwet's AC2 (weighted companion to AC1) ----------

test("R2: gwetAC2 identity weights ≡ gwetAC1 exactly (any data, incl. missing)", () => {
  const d1 = kappaGoldenData();
  assert.equal(gwetAC2(d1, { weights: "identity" }), gwetAC1(d1));
  const d2 = [
    { unitId: "u1", coder: "c1", value: "A" },
    { unitId: "u1", coder: "c2", value: "A" },
    { unitId: "u1", coder: "c3", value: "B" },
    { unitId: "u2", coder: "c1", value: "A" },
    { unitId: "u2", coder: "c2", value: "A" },
    { unitId: "u3", coder: "c1", value: "B" },
    { unitId: "u3", coder: "c2", value: "B" },
    { unitId: "u3", coder: "c3", value: "B" },
    { unitId: "u4", coder: "c2", value: "C" }, // m=1: counts for π, not p_a
  ];
  assert.equal(gwetAC2(d2, { weights: "identity" }), gwetAC1(d2));
});

test("R2: gwetAC2 with q=2 categories and linear weights ≡ AC1 (weights reduce to identity)", () => {
  // q=2 → off-diagonal linear weight 1 − 1/(q−1) = 0, diagonal 1 → identity.
  const data = kappaGoldenData();
  const ac2 = gwetAC2(data, { weights: "linear", order: ["no", "yes"] });
  assert.ok(Math.abs(ac2 - gwetAC1(data)) < EPS);
});

test("R2: gwetAC2 perfect agreement → 1 (all weight kinds)", () => {
  const data = rows2([[1, 1], [2, 2], [3, 3], [1, 1], [2, 2]]);
  for (const weights of ["identity", "linear", "quadratic"]) {
    assert.ok(Math.abs(gwetAC2(data, { weights }) - 1) < EPS, weights);
  }
});

test("R2: gwetAC2 hand-derived golden: linear weights on (1,1),(2,2),(3,3),(1,3) → 13/29", () => {
  // q=3, linear weights w_kl = 1 − |k−l|/2: w12=w23=1/2, w13=0, diag 1.
  // p_a per unit (m=2, denominator m(m−1)=2):
  //   (1,1): r=[2,0,0], r*_1 = w11·2 = 2 → Σ r_k(r*_k−1) = 2·1 = 2 → 1
  //   (2,2), (3,3): same → 1 each
  //   (1,3): r=[1,0,1], r*_1 = 1 + w13·1 = 1, r*_3 = 1 → Σ = 1·0 + 1·0 = 0 → 0
  //   p_a = (1+1+1+0)/4 = 3/4
  // π_k = mean of r_ik/m_i: π = [(1+½)/4, 1/4, (1+½)/4] = [3/8, 1/4, 3/8]
  //   Σ π_k(1−π_k) = 15/64 + 12/64 + 15/64 = 42/64 = 21/32
  // T_w = Σ_kl w_kl = 3 + 2(½ + 0 + ½) = 5
  //   p_e = T_w/(q(q−1)) · Σπ(1−π) = 5/6 · 21/32 = 35/64
  // AC2 = (3/4 − 35/64)/(1 − 35/64) = (13/64)/(29/64) = 13/29
  const ac2 = gwetAC2(weightedKappaData(), { weights: "linear" });
  assert.ok(Math.abs(ac2 - 13 / 29) < EPS, `AC2 = ${ac2}`);
});

test("R2: gwetAC2 order rules — string labels need order unless weights are identity", () => {
  const strData = rows2([["low", "low"], ["medium", "medium"], ["high", "high"], ["low", "high"]]);
  assertThrowsCode(() => gwetAC2(strData, { weights: "linear" }), "E_STAT_INPUT");
  // identity weights are order-insensitive → no order needed
  assert.ok(Number.isFinite(gwetAC2(strData, { weights: "identity" })));
  // recode invariance: string + order EXACTLY equals numeric recode
  const kStr = gwetAC2(strData, { weights: "linear", order: ["low", "medium", "high"] });
  const kNum = gwetAC2(weightedKappaData(), { weights: "linear" });
  assert.equal(kStr, kNum);
  assert.ok(Math.abs(kStr - 13 / 29) < EPS);
});

test("R2: gwetAC2 validation — bad weights, single category", () => {
  assertThrowsCode(() => gwetAC2(weightedKappaData(), { weights: "cubic" }), "E_STAT_INPUT");
  assertThrowsCode(() => gwetAC2(weightedKappaData(), {}), "E_STAT_INPUT");
  assertThrowsCode(
    () => gwetAC2(rows2([["x", "x"], ["x", "x"]]), { weights: "identity" }),
    "E_STAT_DEGENERATE"
  );
});

// ---------- M1: ""/NaN coding values are data bugs, not categories ----------

test('M1: two "" codings throw E_STAT_INPUT, not α = 1', () => {
  const data = [
    { unitId: "u1", coder: "A", value: "" },
    { unitId: "u1", coder: "B", value: "" },
  ];
  assert.throws(
    () => krippendorffAlpha(data, { level: "nominal" }),
    (err) =>
      err instanceof ConcordError &&
      err.code === "E_STAT_INPUT" &&
      /missing codings must be absent rows/.test(err.message)
  );
  assertThrowsCode(() => percentAgreement(data), "E_STAT_INPUT");
});

test("M1: NaN coding values throw E_STAT_INPUT", () => {
  const data = [
    { unitId: "u1", coder: "A", value: NaN },
    { unitId: "u1", coder: "B", value: 1 },
  ];
  assertThrowsCode(() => krippendorffAlpha(data, { level: "nominal" }), "E_STAT_INPUT");
});

// ---------- boot.js ----------

test("mcnemar golden: b=3, c=2 → chi2 = 0.2, pExact = 1.0", () => {
  const pairs = [
    { a: 1, b: 0 }, { a: 1, b: 0 }, { a: 1, b: 0 }, // b = 3
    { a: 0, b: 1 }, { a: 0, b: 1 },                 // c = 2
    { a: 1, b: 1 }, { a: 0, b: 0 },                 // concordant ignored
  ];
  const r = mcnemar(pairs);
  assert.equal(r.b, 3);
  assert.equal(r.c, 2);
  assert.ok(Math.abs(r.chi2 - 0.2) < EPS);
  // pExact = min(1, 2·Σ_{i=0}^{2} C(5,i)/32) = min(1, 2·16/32) = 1.0
  assert.ok(Math.abs(r.pExact - 1.0) < EPS);
});

test("mcnemar: no discordant pairs → chi2 0, pExact 1", () => {
  const r = mcnemar([{ a: 1, b: 1 }, { a: 0, b: 0 }]);
  assert.equal(r.b, 0);
  assert.equal(r.c, 0);
  assert.equal(r.chi2, 0);
  assert.equal(r.pExact, 1);
});

test("mcnemar: b=10, c=0 → exact p = 2·(1/2)^10", () => {
  const pairs = Array.from({ length: 10 }, () => ({ a: 1, b: 0 }));
  const r = mcnemar(pairs);
  assert.ok(Math.abs(r.chi2 - 10) < EPS);
  assert.ok(Math.abs(r.pExact - 2 * Math.pow(0.5, 10)) < EPS);
});

test("M3: bootstrapCI returns {lo, hi, method: 'bootstrap-percentile'}", () => {
  const ci = bootstrapCI(kappaGoldenData(), (d) => cohenKappa(d), { B: 50, seed: 5 });
  assert.equal(ci.method, "bootstrap-percentile");
  assert.deepEqual(Object.keys(ci).sort(), ["hi", "lo", "method"]);
});

test("bootstrapCI: deterministic given seed, lo ≤ hi, sane range", () => {
  const data = kappaGoldenData();
  const stat = (d) => cohenKappa(d);
  const ci1 = bootstrapCI(data, stat, { B: 200, seed: 11 });
  const ci2 = bootstrapCI(data, stat, { B: 200, seed: 11 });
  assert.deepEqual(ci1, ci2);
  assert.ok(ci1.lo <= ci1.hi);
  assert.ok(ci1.lo >= -1 - EPS && ci1.hi <= 1 + EPS);
  // point estimate κ=0.5 should be inside a 95% bootstrap CI for its own data
  assert.ok(ci1.lo <= 0.5 && 0.5 <= ci1.hi);
});

test("bootstrapCI: perfect agreement → CI collapses to [1,1]", () => {
  const data = rows2([
    ["yes", "yes"], ["no", "no"], ["yes", "yes"], ["no", "no"],
    ["yes", "yes"], ["no", "no"], ["yes", "yes"], ["no", "no"],
  ]);
  const ci = bootstrapCI(data, (d) => krippendorffAlpha(d, { level: "nominal" }), {
    B: 100,
    seed: 3,
  });
  assert.ok(Math.abs(ci.lo - 1) < EPS);
  assert.ok(Math.abs(ci.hi - 1) < EPS);
});

test("tostEquivalence: perfect 3-coder agreement → equivalent with any positive bound", () => {
  const data = [];
  const values = ["A", "B", "A", "B", "A", "B"];
  values.forEach((v, i) => {
    for (const c of ["c1", "c2", "c3"]) data.push({ unitId: `u${i}`, coder: c, value: v });
  });
  const r = tostEquivalence(data, { bound: 0.1, level: "nominal" });
  assert.equal(r.alphaLOO.length, 3);
  for (const a of r.alphaLOO) assert.ok(Math.abs(a - 1) < EPS);
  assert.equal(r.equivalent, true);
  assert.ok(Math.abs(r.p - 0) < EPS);
});

test("tostEquivalence: one deviant coder + tight bound → not equivalent", () => {
  // c3 disagrees with c1/c2 on most units; dropping c3 moves α a lot.
  const data = [];
  const truth = ["A", "B", "A", "B", "A", "B", "A", "B"];
  truth.forEach((v, i) => {
    data.push({ unitId: `u${i}`, coder: "c1", value: v });
    data.push({ unitId: `u${i}`, coder: "c2", value: v });
    data.push({ unitId: `u${i}`, coder: "c3", value: i < 6 ? (v === "A" ? "B" : "A") : v });
  });
  const r = tostEquivalence(data, { bound: 0.01, level: "nominal" });
  assert.equal(r.alphaLOO.length, 3);
  assert.equal(r.equivalent, false);
  assert.ok(r.p > 0.05);
});

// ---------- edge cases: clean ConcordErrors, never NaN ----------

function assertThrowsCode(fn, code) {
  assert.throws(fn, (err) => err instanceof ConcordError && err.code === code);
}

test("edge: empty / all-missing data throws E_STAT_INSUFFICIENT", () => {
  assertThrowsCode(() => percentAgreement([]), "E_STAT_INSUFFICIENT");
  assertThrowsCode(() => krippendorffAlpha([], { level: "nominal" }), "E_STAT_INSUFFICIENT");
  assertThrowsCode(() => gwetAC1([]), "E_STAT_INSUFFICIENT");
});

test("edge: single unit (no pairable comparison across units) throws", () => {
  const data = [
    { unitId: "u1", coder: "A", value: "x" },
    { unitId: "u1", coder: "B", value: "y" },
  ];
  // α: D_e needs n(n−1) with n=2 values, fine — but single CATEGORY per next test;
  // here two categories on one unit: α defined (D_e>0). n=1 *units* with only one
  // coding each is the degenerate case:
  const lonely = [{ unitId: "u1", coder: "A", value: "x" }];
  assertThrowsCode(() => krippendorffAlpha(lonely, { level: "nominal" }), "E_STAT_INSUFFICIENT");
  assertThrowsCode(() => percentAgreement(lonely), "E_STAT_INSUFFICIENT");
  assertThrowsCode(() => cohenKappa(lonely), "E_STAT_INPUT");
  // and the two-value single-unit α is still computable:
  const a = krippendorffAlpha(data, { level: "nominal" });
  assert.ok(Number.isFinite(a));
});

test("edge: single category throws E_STAT_DEGENERATE (κ, α, AC1)", () => {
  const data = rows2([["x", "x"], ["x", "x"], ["x", "x"]]);
  assertThrowsCode(() => cohenKappa(data), "E_STAT_DEGENERATE");
  assertThrowsCode(() => krippendorffAlpha(data, { level: "nominal" }), "E_STAT_DEGENERATE");
  assertThrowsCode(() => gwetAC1(data), "E_STAT_DEGENERATE");
});

test("edge: cohenKappa requires exactly 2 coders", () => {
  const data = [
    { unitId: "u1", coder: "A", value: "x" },
    { unitId: "u1", coder: "B", value: "y" },
    { unitId: "u1", coder: "C", value: "x" },
    { unitId: "u2", coder: "A", value: "x" },
    { unitId: "u2", coder: "B", value: "x" },
    { unitId: "u2", coder: "C", value: "y" },
  ];
  assertThrowsCode(() => cohenKappa(data), "E_STAT_INPUT");
});

test("edge: malformed rows and bad options throw E_STAT_INPUT", () => {
  assertThrowsCode(() => percentAgreement([{ unitId: "u1", value: "x" }]), "E_STAT_INPUT");
  assertThrowsCode(() => percentAgreement([{ unitId: "u1", coder: "A", value: null }]), "E_STAT_INPUT");
  assertThrowsCode(() => krippendorffAlpha(rows2([["a", "b"]]), { level: "ratio" }), "E_STAT_INPUT");
  assertThrowsCode(() => krippendorffAlpha(rows2([["a", "b"]]), {}), "E_STAT_INPUT");
  assertThrowsCode(() => cohenKappa(kappaGoldenData(), { weighted: "cubic" }), "E_STAT_INPUT");
  assertThrowsCode(() => mcnemar([{ a: 2, b: 0 }]), "E_STAT_INPUT");
  assertThrowsCode(() => mcnemar("nope"), "E_STAT_INPUT");
});

test("edge: krippendorff interval requires numeric values", () => {
  assertThrowsCode(
    () => krippendorffAlpha(rows2([["a", "b"], ["a", "a"]]), { level: "interval" }),
    "E_STAT_INPUT"
  );
});

test("edge: perClass with unknown gold coder throws", () => {
  const data = rows2([["a", "b"]]);
  assertThrowsCode(() => perClass(data, "nobody"), "E_STAT_INPUT");
});

test("edge: confusion with no jointly coded units throws E_STAT_INSUFFICIENT", () => {
  const data = [
    { unitId: "u1", coder: "A", value: "x" },
    { unitId: "u2", coder: "B", value: "y" },
  ];
  assertThrowsCode(() => confusion(data, "A", "B"), "E_STAT_INSUFFICIENT");
});

test("edge: tostEquivalence needs ≥3 coders and a positive bound", () => {
  const two = rows2([["a", "a"], ["b", "b"], ["a", "b"]]);
  assertThrowsCode(() => tostEquivalence(two, { bound: 0.1, level: "nominal" }), "E_STAT_INSUFFICIENT");
  const three = [];
  ["A", "B", "A", "B"].forEach((v, i) => {
    for (const c of ["c1", "c2", "c3"]) three.push({ unitId: `u${i}`, coder: c, value: v });
  });
  assertThrowsCode(() => tostEquivalence(three, { bound: 0, level: "nominal" }), "E_STAT_INPUT");
  assertThrowsCode(() => tostEquivalence(three, { level: "nominal" }), "E_STAT_INPUT");
});

test("edge: bootstrapCI validates B and alpha", () => {
  const data = kappaGoldenData();
  assertThrowsCode(() => bootstrapCI(data, (d) => cohenKappa(d), { B: 0, seed: 1 }), "E_STAT_INPUT");
  assertThrowsCode(() => bootstrapCI(data, "notafn", { seed: 1 }), "E_STAT_INPUT");
  assertThrowsCode(
    () => bootstrapCI(data, (d) => cohenKappa(d), { B: 100, seed: 1, alpha: 1.5 }),
    "E_STAT_INPUT"
  );
});
