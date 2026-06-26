// Deterministic test for the SPEC-AUTOFILL GATE — mirrors the cascade effect in RFQModalV3.tsx.
// Policy: the cascade (inferSpecsFromApplication) is BUYER-DRIVEN, never intent/planner-driven.
// It fires ONLY after the buyer has manually filled ≥2 specs (the planner lead / name-detected spec
// is NOT a trigger), then fills at most 2 closest-matching still-empty specs. Fully off in re-post.
// NO LLM, NO network.

const CASCADE_MIN_MANUAL = 2;
const CASCADE_MAX_FILL = 2;

// mirror the gate: does the cascade fire?
function cascadeFires({ manualSpecs, dynamicSpecs, isqSpecCount, repostSource, hasKey = true, engineOn = true }) {
  if (!engineOn || !hasKey || isqSpecCount === 0 || repostSource) return false;
  const manualEntries = [...manualSpecs].filter((n) => (dynamicSpecs[n] || '').trim());
  if (manualEntries.length < CASCADE_MIN_MANUAL) return false;
  return true;
}

// mirror the apply cap: how many of the LLM's returned specs actually get applied?
function appliedCount(returnedSpecs, emptyTargets) {
  const applied = [];
  for (const [k, v] of Object.entries(returnedSpecs || {})) {
    if (applied.length >= CASCADE_MAX_FILL) break;
    const m = emptyTargets.find((n) => n.toLowerCase() === k.toLowerCase());
    if (m && v) applied.push(m);
  }
  return applied.length;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the screenshot bug: fresh page, only a name-detected/intent lead, buyer set NOTHING → must NOT fire ──
ok('fresh page, 0 manual (only name-detected lead) → cascade does NOT fire',
  cascadeFires({ manualSpecs: [], dynamicSpecs: { 'Machine Type': 'Spiral' }, isqSpecCount: 8, repostSource: null }) === false);
ok('1 manual spec → still does NOT fire (waits for the 2nd)',
  cascadeFires({ manualSpecs: ['Binding Capacity'], dynamicSpecs: { 'Binding Capacity': '300 sheets' }, isqSpecCount: 8, repostSource: null }) === false);
ok('2 manual specs → cascade fires',
  cascadeFires({ manualSpecs: ['Binding Capacity', 'Punch Capacity'], dynamicSpecs: { 'Binding Capacity': '300 sheets', 'Punch Capacity': '15 sheets' }, isqSpecCount: 8, repostSource: null }) === true);
ok('3 manual specs → fires',
  cascadeFires({ manualSpecs: ['A', 'B', 'C'], dynamicSpecs: { A: '1', B: '2', C: '3' }, isqSpecCount: 8, repostSource: null }) === true);

// ── empty values don't count toward the ≥2 gate ──
ok('manualSpecs with empty/whitespace values do NOT count toward the gate',
  cascadeFires({ manualSpecs: ['A', 'B'], dynamicSpecs: { A: '', B: '  ' }, isqSpecCount: 8, repostSource: null }) === false);

// ── re-post fully exempt ──
ok('re-post (repostSource set) → cascade NEVER fires, even with ≥2 manual',
  cascadeFires({ manualSpecs: ['A', 'B', 'C'], dynamicSpecs: { A: '1', B: '2', C: '3' }, isqSpecCount: 8, repostSource: { title: 'Frosted PVC Bag' } }) === false);

// ── preconditions ──
ok('no ISQ specs loaded → no fire', cascadeFires({ manualSpecs: ['A', 'B'], dynamicSpecs: { A: '1', B: '2' }, isqSpecCount: 0, repostSource: null }) === false);
ok('no gemini key → no fire', cascadeFires({ manualSpecs: ['A', 'B'], dynamicSpecs: { A: '1', B: '2' }, isqSpecCount: 8, repostSource: null, hasKey: false }) === false);
ok('engine off → no fire', cascadeFires({ manualSpecs: ['A', 'B'], dynamicSpecs: { A: '1', B: '2' }, isqSpecCount: 8, repostSource: null, engineOn: false }) === false);

// ── cap: at most 2 fills regardless of how many the LLM returns ──
ok('cap: LLM returns 5 → at most 2 applied',
  appliedCount({ 'Operation Mode': 'Manual', 'Max Paper Size': 'A4', Color: 'Blue', Warranty: '1yr', Weight: '5kg' }, ['Operation Mode', 'Max Paper Size', 'Color', 'Warranty', 'Weight']) === 2);
ok('cap: LLM returns 1 → 1 applied', appliedCount({ 'Operation Mode': 'Manual' }, ['Operation Mode', 'Max Paper Size']) === 1);
ok('cap: LLM returns 0 → 0 applied', appliedCount({}, ['Operation Mode']) === 0);
ok('cap: LLM returns specs not in targets → 0 applied', appliedCount({ Nonexistent: 'x' }, ['Operation Mode']) === 0);

console.log(`\ncascadegatetest (spec auto-fill: buyer-driven ≥2 manual → ≤2 closest · never intent/planner · re-post exempt): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
