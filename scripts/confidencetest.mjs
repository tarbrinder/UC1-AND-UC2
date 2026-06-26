// Deterministic test for CONFIDENCE-AWARE RENDERING — mirrors src/lib/confidenceRender.ts.
// The Golden Rule, applied: ≥70 chip · 40-69 confirm · <40 hide. Boundaries are the whole point.

const DEFAULT = { chip: 70, confirm: 40 };
function renderMode(confidence, t = DEFAULT) {
  const c = typeof confidence === 'number' && isFinite(confidence) ? confidence : 0;
  if (c >= t.chip) return 'chip';
  if (c >= t.confirm) return 'confirm';
  return 'hide';
}
const shouldSurface = (c, t) => renderMode(c, t) !== 'hide';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the three bands ──
ok('90 → chip', renderMode(90) === 'chip');
ok('70 → chip (lower boundary inclusive)', renderMode(70) === 'chip');
ok('69 → confirm (just below chip)', renderMode(69) === 'confirm');
ok('55 → confirm', renderMode(55) === 'confirm');
ok('40 → confirm (lower boundary inclusive)', renderMode(40) === 'confirm');
ok('39 → hide (just below confirm)', renderMode(39) === 'hide');
ok('10 → hide', renderMode(10) === 'hide');
ok('0 → hide', renderMode(0) === 'hide');

// ── the live signals (from the extractor) ──
ok("Lucknow location_preference (80) → chip (assert, don't ask)", renderMode(80) === 'chip');
ok('a once-mentioned place (~50) → confirm (ask)', renderMode(50) === 'confirm');
ok('a faint hint (30) → hide', renderMode(30) === 'hide');

// ── shouldSurface ──
ok('shouldSurface: 70 true', shouldSurface(70) === true);
ok('shouldSurface: 39 false', shouldSurface(39) === false);

// ── graceful: null/undefined/NaN → hide (never guess) ──
ok('null → hide', renderMode(null) === 'hide');
ok('undefined → hide', renderMode(undefined) === 'hide');
ok('NaN → hide', renderMode(NaN) === 'hide');

// ── custom thresholds ──
ok('custom thresholds respected', renderMode(60, { chip: 60, confirm: 30 }) === 'chip' && renderMode(35, { chip: 60, confirm: 30 }) === 'confirm');

console.log(`\nconfidencetest (Golden Rule ≥70 chip · 40-69 confirm · <40 hide · boundaries · live-signal bands · null-safe · custom thresholds): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
