// Deterministic test for A10/T3 requirement-mode (unit-tier aware) + T1 intent qty+unit gate + the
// "Just 1?" nudge. Mirrors requirementMode() + qtyReady + the nudge condition in RFQModalV3.tsx.

const UNIT_DISCRETE = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i;
const UNIT_BULK = /tonne|quintal|\bmt\b|\bton\b|truck|container|\bkl\b/i;
const UNIT_MEASURE = /\bkg\b|kilogram|\bgram|\bgm\b|litre|liter|\bml\b|\bmeter|\bmetre|\bcm\b|\bft\b|feet|inch|yard|sq\b|sqft|cubic/i;
function requirementMode(qty, unit, archetype) {
  const q = Number(qty) || 0;
  if (archetype === 'capital') return { mode: 'capital', retailish: false };
  if (q > 0 && UNIT_BULK.test(unit || '')) return { mode: 'sized', retailish: false };
  if (q > 0 && q <= 10 && UNIT_DISCRETE.test(unit || '')) return { mode: 'retail_single', retailish: true };
  if (q > 0 && q <= 1 && UNIT_MEASURE.test(unit || '')) return { mode: 'uncertain', retailish: false };
  if (q > 0) return { mode: 'sized', retailish: false };
  return { mode: 'unknown', retailish: false };
}
const nudgeFires = (qty, unit) => qty === '1' && !!unit && UNIT_MEASURE.test(unit);
const qtyReady = (unitOptionsLen, qty, unit) => unitOptionsLen === 0 || (Number(qty) > 0 && !!unit);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// T3 — the TMT Bar fix: 1 Tonne is a real B2B order, NOT retail and NOT "less".
ok('TMT 1 Tonne → sized (NOT retail, NOT uncertain)', requirementMode('1', 'Tonne', 'commodity').mode === 'sized');
ok('TMT 1 Tonne → NOT retailish', requirementMode('1', 'Tonne', 'commodity').retailish === false);
ok('1 Quintal → sized (bulk unit)', requirementMode('1', 'Quintal', 'commodity').mode === 'sized');
ok('1 Bundle → sized (not bulk/discrete/measure → sized, no false retail)', requirementMode('1', 'Bundle', 'commodity').mode === 'sized');
// A10 preserved: 1 discrete unit of a commodity is still retail/one-off.
ok('cable lug 1 Piece → retail_single (A10 preserved)', requirementMode('1', 'Piece', 'commodity').retailish === true);
ok('diaper 1 Piece → retail_single', requirementMode('1', 'Piece', 'commodity').mode === 'retail_single');
ok('5 Piece → retail_single', requirementMode('5', 'piece', 'commodity').mode === 'retail_single');
ok('11 Piece → sized (over one-off threshold)', requirementMode('11', 'piece', 'commodity').mode === 'sized');
ok('500 Piece → sized', requirementMode('500', 'piece', 'commodity').retailish === false);
ok('1 KG → uncertain (small measure, maybe a sample)', requirementMode('1', 'KG', 'commodity').mode === 'uncertain');
ok('1 unit CAPITAL (machine) → capital, NOT retail', requirementMode('1', 'unit', 'capital').retailish === false);
ok('qty 0 → unknown', requirementMode('0', 'Piece', 'commodity').mode === 'unknown');

// T3 nudge — fires ONLY for a small measure unit at qty 1; never Tonne / Bundle / Piece.
ok('nudge: 1 Tonne → NO nudge (it was wrong before)', nudgeFires('1', 'Tonne') === false);
ok('nudge: 1 Bundle → NO nudge', nudgeFires('1', 'Bundle') === false);
ok('nudge: 1 Piece → NO nudge (1 piece is fine)', nudgeFires('1', 'Piece') === false);
ok('nudge: 1 KG → nudge (could be a sample)', nudgeFires('1', 'KG') === true);
ok('nudge: 500 Tonne → NO nudge', nudgeFires('500', 'Tonne') === false);

// T1 — intent waits for qty AND unit (when the category has units).
ok('no unit options → intent ready immediately', qtyReady(0, '', '') === true);
ok('units + qty + unit set → ready', qtyReady(3, '100', 'Tonne') === true);
ok('units + qty but NO unit → NOT ready', qtyReady(3, '100', '') === false);
ok('units + unit but NO qty → NOT ready', qtyReady(3, '', 'Tonne') === false);

console.log(`\nrequirementmodetest (T3 unit-tier mode + nudge + T1 gate): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
