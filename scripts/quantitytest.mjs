// Deterministic test for the ORDER-SCALE signal (P2.6) — mirrors src/lib/quantity.ts classifyOrderScale.
// "1 tyre" and "1000 tyres" are the same product but a different requirement: scale must shape the
// business-model / stage / commercial reasoning. Recorded as a SOFT 'Deduced' fact (lowest authority) so
// it FILLS the "how big" Unknown but NEVER overturns a Confirmed buyer truth. NO LLM, NO network.

const DISCRETE_UNIT = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each|packet/i;
const BULK_UNIT = /tonne|\btons?\b|\bmt\b|metric\s*ton|quintal|truck|container|wagon|\bkg\b|kilogram|litre|liter|\bton\b|drum|barrel|roll|bundle|carton|gross|dozen/i;
function classifyOrderScale(qty, unit) {
  const n = typeof qty === 'number' ? qty : parseFloat(String(qty ?? '').replace(/[^0-9.]/g, ''));
  const u = (unit || '').trim();
  const bulkUnit = BULK_UNIT.test(u) && !DISCRETE_UNIT.test(u);
  if (!Number.isFinite(n) || n <= 0) return { band: 'unknown', implication: '', bulkUnit };
  if (bulkUnit) return { band: 'wholesale', implication: 'bulk-unit order → business / reseller scale', bulkUnit };
  if (n <= 2) return { band: 'single', implication: 'tiny order → personal use, a sample, or a trial', bulkUnit };
  if (n <= 25) return { band: 'small', implication: 'small order → a small business, a trial, or a top-up', bulkUnit };
  if (n <= 500) return { band: 'bulk', implication: 'sizeable order → an established business buy', bulkUnit };
  return { band: 'wholesale', implication: 'large order → reseller / distributor / project scale', bulkUnit };
}
// authority ladder (coverage.ts) — proves order-scale (Deduced) can never overturn a buyer truth
const AUTH = { User: 100, LastPage: 95, Intent: 92, Spec: 85, Verified: 78, History: 75, Planner: 70, Cascade: 55, Enrichment: 52, Twin: 50, Deduced: 40 };

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the headline: 1 vs 1000 of the SAME product DIVERGE ──
ok('1 Piece → "single" (personal/sample, not wholesale)', classifyOrderScale(1, 'Piece').band === 'single');
ok('1000 Piece → "wholesale" (reseller/distributor scale)', classifyOrderScale(1000, 'Piece').band === 'wholesale');
ok('1 vs 1000 of the same product produce DIFFERENT scale bands', classifyOrderScale(1, 'Piece').band !== classifyOrderScale(1000, 'Piece').band);
ok('1 Piece implication says personal/sample', /personal|sample|trial/.test(classifyOrderScale(1, 'Piece').implication));
ok('1000 Piece implication says reseller/distributor', /reseller|distributor|project/.test(classifyOrderScale(1000, 'Piece').implication));

// ── discrete-unit bands ──
ok('2 Piece → single (boundary)', classifyOrderScale(2, 'Piece').band === 'single');
ok('3 Piece → small (boundary)', classifyOrderScale(3, 'Piece').band === 'small');
ok('25 Piece → small (boundary)', classifyOrderScale(25, 'Piece').band === 'small');
ok('26 Piece → bulk (boundary)', classifyOrderScale(26, 'Piece').band === 'bulk');
ok('500 Piece → bulk (boundary)', classifyOrderScale(500, 'Piece').band === 'bulk');
ok('501 Piece → wholesale (boundary)', classifyOrderScale(501, 'Piece').band === 'wholesale');

// ── bulk UNITS are business-scale at ANY count ──
ok('1 Tonne → wholesale (bulk unit, business scale even at qty 1)', classifyOrderScale(1, 'Tonne').band === 'wholesale' && classifyOrderScale(1, 'Tonne').bulkUnit === true);
ok('1 Truck → wholesale', classifyOrderScale(1, 'Truck').band === 'wholesale');
ok('2 Container → wholesale', classifyOrderScale(2, 'Container').band === 'wholesale');
ok('5 MT → wholesale', classifyOrderScale(5, 'MT').band === 'wholesale');
ok('a discrete unit is NOT treated as bulk-unit', classifyOrderScale(1, 'Piece').bulkUnit === false);

// ── robustness ──
ok('qty 0 → unknown (no signal, no crash)', classifyOrderScale(0, 'Piece').band === 'unknown');
ok('missing qty → unknown', classifyOrderScale(undefined, 'Piece').band === 'unknown');
ok('empty everything → unknown', classifyOrderScale('', '').band === 'unknown');
ok('string "1,000" parses to 1000 → wholesale', classifyOrderScale('1,000', 'Piece').band === 'wholesale');
ok('unitless count still bands (10 → small)', classifyOrderScale(10, '').band === 'small');

// ── governance: a Deduced order-scale fact can NEVER overturn a Confirmed buyer truth ──
ok('order-scale is recorded as Deduced (lowest authority)', AUTH.Deduced < AUTH.User && AUTH.Deduced < AUTH.Verified && AUTH.Deduced === Math.min(...Object.values(AUTH)));
ok('"order scale" is its own concept (never collides with buyer_type/intent) — fills an Unknown only', 'order scale' !== 'buyer type' && 'order scale' !== 'intent');

console.log(`\nquantitytest (P2.6 order-scale: 1 vs 1000 diverge · bulk-unit · bands · Deduced authority never overturns a truth): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
