// Deterministic test for CATEGORY CONFIDENCE — mirrors src/lib/categoryConfidence.ts.
// The gate that decides consume-heavily / consume-lightly / ignore (buyer-only). Modelled on the
// REAL audit: Diesel Generator (76 calls → rich) vs Antique Door (0 calls → empty). NO LLM.

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
function categoryConfidence(payload) {
  const ci = payload || {};
  const cs = Array.isArray(ci.critical_specs) ? ci.critical_specs.filter((c) => c && (c.name || c.maps_to_isq)) : [];
  const callsKnown = typeof ci.calls_analyzed === 'number';
  const calls = callsKnown ? num(ci.calls_analyzed) : -1;
  const criticalsWithFreq = cs.filter((c) => num(c.seller_frequency) > 0).length;
  const criticalsMapped = cs.filter((c) => c.maps_to_isq && String(c.maps_to_isq).trim()).length;
  const intents = Array.isArray(ci.intent_patterns) ? ci.intent_patterns.length : 0;
  const blockers = Array.isArray(ci.deal_blockers) ? ci.deal_blockers.length : 0;
  const p = ci.price_distribution_inr;
  const priceUsable = !!p && num(p.max) > 0 && num(p.max) > num(p.min);
  const signals = { calls: Math.max(calls, 0), criticals: cs.length, criticalsWithFreq, criticalsMapped, intents, blockers, priceUsable };
  if (cs.length === 0 || calls === 0) return { score: 0, band: 'empty', consume: false, fuse: false, signals, reason: 'empty' };
  const score = Math.round((Math.min(cs.length, 8) / 8) * 35 + (criticalsWithFreq / cs.length) * 15 + (criticalsMapped / cs.length) * 15 + (Math.min(intents, 5) / 5) * 10 + (Math.min(blockers, 4) / 4) * 10 + (priceUsable ? 10 : 0) + (Math.min(Math.max(calls, 0), 30) / 30) * 5);
  const band = score >= 65 ? 'rich' : score >= 30 ? 'thin' : 'empty';
  return { score, band, consume: band !== 'empty', fuse: band === 'rich', signals, reason: '' };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── DIESEL GENERATOR (the real rich case): 12 criticals, all freq+ISQ, 10 intents, 8 blockers, no price, 76 calls ──
const diesel = categoryConfidence({
  critical_specs: Array.from({ length: 12 }, (_, i) => ({ name: 'Spec' + i, seller_frequency: 100 - i * 8, maps_to_isq: 'isq' + i })),
  intent_patterns: Array.from({ length: 10 }, (_, i) => ({ intent: 'use' + i, frequency: 50 })),
  deal_blockers: Array.from({ length: 8 }, (_, i) => ({ name: 'b' + i, frequency: 30 })),
  price_distribution_inr: null, calls_analyzed: 76,
});
ok('Diesel → RICH band', diesel.band === 'rich');
ok('Diesel → consume + fuse both true', diesel.consume === true && diesel.fuse === true);
ok('Diesel score is high (≥85)', diesel.score >= 85);

// ── ANTIQUE DOOR (the real empty case): 0 calls, 0 criticals ──
const antique = categoryConfidence({ critical_specs: [], intent_patterns: [], deal_blockers: [], calls_analyzed: 0 });
ok('Antique Door → EMPTY band', antique.band === 'empty');
ok('Antique Door → consume=false (buyer-only) + fuse=false', antique.consume === false && antique.fuse === false);
ok('Antique Door score = 0', antique.score === 0);

// ── THIN category: 4 criticals, 2 intents, 1 blocker, no price, 12 calls → consume but DON'T fuse ──
const thin = categoryConfidence({
  critical_specs: [{ name: 'A', seller_frequency: 60, maps_to_isq: 'a' }, { name: 'B', seller_frequency: 40, maps_to_isq: 'b' }, { name: 'C', seller_frequency: 30, maps_to_isq: 'c' }, { name: 'D', seller_frequency: 20, maps_to_isq: 'd' }],
  intent_patterns: [{ intent: 'x' }, { intent: 'y' }], deal_blockers: [{ name: 'z' }], calls_analyzed: 12,
});
ok('Thin → THIN band (30-64)', thin.band === 'thin' && thin.score >= 30 && thin.score < 65);
ok('Thin → consume=true but fuse=false (don\'t multiply weak intel)', thin.consume === true && thin.fuse === false);

// ── GATE behaviour: 0 criticals despite calls → empty; criticals but 0 calls → empty ──
ok('calls>0 but 0 criticals → empty (built-but-useless)', categoryConfidence({ critical_specs: [], calls_analyzed: 50 }).band === 'empty');
ok('criticals but EXPLICIT 0 calls → empty (no evidence base — Antique Door)', categoryConfidence({ critical_specs: [{ name: 'A', maps_to_isq: 'a' }], calls_analyzed: 0 }).band === 'empty');
// ROBUSTNESS: a rich cache MISSING the calls_analyzed field must NOT be wrongly gated to empty —
// trust the criticals, just forgo the call-volume bonus.
const noCallsField = categoryConfidence({ critical_specs: Array.from({ length: 10 }, (_, i) => ({ name: 'S' + i, seller_frequency: 50, maps_to_isq: 'isq' + i })), intent_patterns: [{ intent: 'x' }, { intent: 'y' }], deal_blockers: [{ name: 'z' }, { name: 'w' }] /* no calls_analyzed */ });
ok('calls_analyzed MISSING (not 0) + rich criticals → still consumes (relies on criticals)', noCallsField.consume === true && noCallsField.band !== 'empty');
ok('missing-calls report shows 0 (not -1) in signals', noCallsField.signals.calls === 0);

// ── price spread ADDS to the score (the missing 10 points for Diesel) ──
const withPrice = categoryConfidence({ critical_specs: [{ name: 'A', seller_frequency: 50, maps_to_isq: 'a' }, { name: 'B', seller_frequency: 40, maps_to_isq: 'b' }, { name: 'C', seller_frequency: 30, maps_to_isq: 'c' }, { name: 'D', seller_frequency: 20, maps_to_isq: 'd' }], intent_patterns: [{ intent: 'x' }, { intent: 'y' }], deal_blockers: [{ name: 'z' }], price_distribution_inr: { min: 31000, median: 360000, max: 1650000 }, calls_analyzed: 12 });
ok('adding usable price → score rises by ~10 vs the no-price thin twin', withPrice.score - thin.score === 10 && withPrice.signals.priceUsable);

// ── unmapped/unranked criticals score LOWER than clean ones (quality matters, not just count) ──
const messy = categoryConfidence({ critical_specs: Array.from({ length: 12 }, (_, i) => ({ name: 'S' + i })), intent_patterns: [], deal_blockers: [], calls_analyzed: 40 });
ok('12 criticals with NO freq + NO ISQ mapping → lower than clean Diesel', messy.score < diesel.score);
ok('messy still consumes if criticals exist (count carries some weight)', messy.consume === true);

// ── graceful ──
ok('null payload → empty, no throw', categoryConfidence(null).band === 'empty' && categoryConfidence(undefined).band === 'empty');
ok('garbage payload → empty', categoryConfidence({ critical_specs: 'nope', calls_analyzed: 'x' }).band === 'empty');

// ── band thresholds are ordered: empty < thin < rich ──
ok('band ordering holds (empty 0 < thin < rich score)', antique.score < thin.score && thin.score < diesel.score);

console.log(`\ncategoryconfidencetest (consume/fuse gate · Diesel=rich · Antique=empty · thin consumes-not-fuses · built-but-useless→empty · price+quality weighting · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
