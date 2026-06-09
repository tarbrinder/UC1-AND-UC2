// Deterministic test for Requirement Mode v2 (R) + T1 intent qty+unit gate + the "Just 1?" nudge.
// Mirrors requirementMode() (8-mode journey/history fusion), qtyReady, and the nudge in RFQModalV3.tsx.

const UNIT_DISCRETE = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i;
const UNIT_BULK = /tonne|quintal|\bmt\b|\bton\b|truck|container|\bkl\b/i;
const UNIT_MEASURE = /\bkg\b|kilogram|\bgram|\bgm\b|litre|liter|\bml\b|\bmeter|\bmetre|\bcm\b|\bft\b|feet|inch|yard|sq\b|sqft|cubic/i;

// v2 fusion: emergency (explicit breakdown/replacement — beats archetype) → nature (capital→project)
// → tiny (sample, dominates) → recurring → bulk → one-off.
// project/emergency read the INTENT ANSWER text (intentVal) too, not just the coarse journey enum.
function requirementMode(qty, unit, archetype = '', journey = '', recurs = false, intentVal = '') {
  const q = Number(qty) || 0;
  const j = (journey || '').toLowerCase();
  const iv = (intentVal || '').toLowerCase();
  const projectish = j === 'project' || archetype === 'project_service' || /\b(project|tender|turnkey|infrastructure)\b/.test(iv);
  const emergencyish = j === 'maintenance' || /\b(replace|replacement|breakdown|repair|urgent|emergency|spare)\b/.test(iv);
  const tiny = q > 0 && q <= 2 && !UNIT_BULK.test(unit || '');
  // Emergency FIRST — an explicit breakdown/replacement beats even a capital archetype (a capital
  // machine being *replaced* is an urgent advance-pay buy, not a capex project).
  if (emergencyish) return { mode: 'emergency', lean: 'advance' };
  if (archetype === 'capital') return { mode: 'capital', lean: 'credit' };
  if (projectish) return { mode: 'project', lean: 'credit' };
  if (tiny) return { mode: 'sample_trial', lean: 'advance' };
  if (recurs) return { mode: 'recurring', lean: 'credit' };
  if (q > 0 && (UNIT_BULK.test(unit || '') || q > 10)) return { mode: 'bulk', lean: 'either' };
  if (q > 0 && q <= 10 && UNIT_DISCRETE.test(unit || '')) return { mode: 'one_off_retail', lean: 'advance' };
  if (q > 0) return { mode: 'bulk', lean: 'either' };
  return { mode: 'unknown', lean: 'either' };
}
const nudgeFires = (qty, unit) => qty === '1' && !!unit && UNIT_MEASURE.test(unit);
const qtyReady = (unitOptionsLen, qty, unit) => unitOptionsLen === 0 || (Number(qty) > 0 && !!unit);

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// Sample/trial — the user's examples (1 diaper / 1 lug / 1 kg). Tiny DOMINATES the repeat pattern + lean advance.
ok('1 lug Piece (industrial journey, bought before) → sample_trial, advance (tiny beats recurring)', (() => { const r = requirementMode('1', 'Piece', 'commodity', 'industrial', true); return r.mode === 'sample_trial' && r.lean === 'advance'; })());
ok('1 diaper Piece → sample_trial', requirementMode('1', 'Piece', 'commodity', 'personal').mode === 'sample_trial');
ok('1 KG chemical → sample_trial (small measure)', requirementMode('1', 'KG', 'commodity').mode === 'sample_trial');

// Recurring — a SIZED repeat order (not tiny) → credit appropriate.
ok('200 Piece, repeat → recurring, credit', (() => { const r = requirementMode('200', 'Piece', 'commodity', 'resale', true); return r.mode === 'recurring' && r.lean === 'credit'; })());
ok('500 Piece, NOT repeat → bulk (not recurring)', requirementMode('500', 'Piece', 'commodity', '', false).mode === 'bulk');

// Bulk / Capital / Project / Emergency
ok('TMT 1 Tonne → bulk (not retail, not sample)', requirementMode('1', 'Tonne', 'commodity').mode === 'bulk');
ok('1 machine (capital) → capital, credit (beats tiny + recurring)', (() => { const r = requirementMode('1', 'unit', 'capital', 'industrial', true); return r.mode === 'capital' && r.lean === 'credit'; })());
ok('1000 tiles for a PROJECT → project, credit', requirementMode('1000', 'sqft', 'commodity', 'project').mode === 'project');
// LIVE finding: TMT 50 Tonne + "Infrastructure projects" answer → project even though journey came back industrial.
ok('TMT 50 Tonne, journey industrial, answer "Infrastructure projects" → project (intent-text beats enum)', requirementMode('50', 'Tonne', 'commodity', 'industrial', false, 'Infrastructure projects').mode === 'project');
ok('replacement part, maintenance journey → emergency, advance (beats tiny)', (() => { const r = requirementMode('1', 'Piece', 'commodity', 'maintenance'); return r.mode === 'emergency' && r.lean === 'advance'; })());
// LIVE finding: Electric Motor classifies as archetype=capital, but intent answer "Replacement Part"
// must win → emergency (explicit breakdown/replacement beats the capital archetype).
ok('Motor (archetype=capital) + answer "Replacement Part" → emergency (intent beats capital)', (() => { const r = requirementMode('1', 'Piece', 'capital', 'industrial', false, 'Replacement Part'); return r.mode === 'emergency' && r.lean === 'advance'; })());
ok('capital machine, NO replacement intent → stays capital (emergency reorder is surgical)', requirementMode('1', 'unit', 'capital', 'industrial', false, 'New production line').mode === 'capital');
ok('5 Piece one-off (no repeat, no journey) → one_off_retail, advance', (() => { const r = requirementMode('5', 'piece', 'commodity'); return r.mode === 'one_off_retail' && r.lean === 'advance'; })());
ok('qty 0 → unknown', requirementMode('0', 'Piece', 'commodity').mode === 'unknown');

// the hierarchy principle: advance-lean modes (sample/one_off/emergency) never silently get credit
ok('payment lean: sample_trial = advance', requirementMode('1', 'Piece', 'commodity').lean === 'advance');
ok('payment lean: recurring = credit', requirementMode('200', 'Piece', 'commodity', '', true).lean === 'credit');

// T3 nudge — only a small measure unit at qty 1; never Tonne / Bundle / Piece.
ok('nudge: 1 Tonne → NO nudge', nudgeFires('1', 'Tonne') === false);
ok('nudge: 1 Bundle → NO nudge', nudgeFires('1', 'Bundle') === false);
ok('nudge: 1 Piece → NO nudge', nudgeFires('1', 'Piece') === false);
ok('nudge: 1 KG → nudge', nudgeFires('1', 'KG') === true);

// T1 — intent waits for qty AND unit.
ok('no unit options → intent ready', qtyReady(0, '', '') === true);
ok('units + qty + unit → ready', qtyReady(3, '100', 'Tonne') === true);
ok('units + qty, no unit → NOT ready', qtyReady(3, '100', '') === false);
ok('units + unit, no qty → NOT ready', qtyReady(3, '', 'Tonne') === false);

console.log(`\nrequirementmodetest (R v2 modes + hierarchy lean + T3 nudge + T1 gate): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
