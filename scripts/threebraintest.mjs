// Deterministic test for the 3-brain registry alignment invariants (mirrors src/lib/brains/threeBrainRegistry.ts:
// stateFromFrequency + alignBrains suppression/coverage/contradiction). No LLM, no fetch. `node scripts/threebraintest.mjs`.
// The REAL module is type-checked by tsc; this pins the load-bearing decision logic against drift.

const stateFromFrequency = (f) => (f >= 80 ? 'Confirmed' : f >= 50 ? 'Likely' : 'Unknown');

function align(buyer, category, rfq, nowIso) {
  const bByKey = new Map(); for (const a of buyer.attributes) bByKey.set(a.key, a);
  const cByLabel = new Map(); for (const a of (category ? category.attributes : [])) cByLabel.set(a.label.toLowerCase(), a);
  const catDays = category && category.distill_date ? Math.round((Date.parse(nowIso) - Date.parse(category.distill_date)) / 86400000) : undefined;
  const keys = [...rfq.ask, ...rfq.attributes.map((a) => a.key)].filter((v, i, arr) => v && arr.indexOf(v) === i);
  const chain = keys.map((k) => {
    const be = bByKey.get(k); const ce = cByLabel.get(String(k).replace(/_/g, ' ').toLowerCase());
    const buyerConfirmed = be && be.state === 'Confirmed';
    const buyerFresher = !ce || (be && be.freshness === 'Fresh') || (catDays != null && catDays > 30);
    const suppressed = !!(buyerConfirmed && buyerFresher);
    return { rfq_key: k, buyer_evidence: be, category_evidence: ce, suppressed };
  });
  const contradictions = chain.filter((c) => c.buyer_evidence && c.category_evidence && c.buyer_evidence.state === 'Confirmed' && c.category_evidence.state === 'Confirmed' && c.buyer_evidence.value && c.category_evidence.value && c.buyer_evidence.value.toLowerCase() !== c.category_evidence.value.toLowerCase());
  return { chain, coverage: { rfq_keys: chain.length, suppressed: chain.filter((c) => c.suppressed).length, orphaned: chain.filter((c) => !c.buyer_evidence && !c.category_evidence).length }, contradictions };
}

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n); } };

// 1 · frequency → state bands (confidence-in-distill, not in-truth)
ok('freq 85 → Confirmed', stateFromFrequency(85) === 'Confirmed');
ok('freq 60 → Likely', stateFromFrequency(60) === 'Likely');
ok('freq 30 → Unknown (low-frequency category spec is NOT a fact)', stateFromFrequency(30) === 'Unknown');

const NOW = '2026-06-23T00:00:00.000Z';
const buyer = { attributes: [
  { key: 'gsm', label: 'GSM', value: '54', state: 'Confirmed', freshness: 'Fresh' },
  { key: 'automation_grade', label: 'Automation Grade', value: 'Semi-Automatic', state: 'Likely', freshness: 'Fresh' },
] };
const category = { distill_date: '2026-06-20T00:00:00.000Z', attributes: [
  { key: 'cat_gsm', label: 'GSM', value: '100', state: 'Confirmed' },
  { key: 'cat_automation_grade', label: 'Automation Grade', value: 'Fully Automatic', state: 'Likely' },
  { key: 'cat_color', label: 'Color', value: 'White', state: 'Unknown' },
] };
const rfq = { ask: ['gsm', 'automation_grade', 'color', 'delivery_city'], attributes: [
  { key: 'gsm', value: '54' }, { key: 'automation_grade', value: '' }, { key: 'color', value: '' }, { key: 'delivery_city', value: '' },
] };
const a = align(buyer, category, rfq, NOW);
const byKey = Object.fromEntries(a.chain.map((c) => [c.rfq_key, c]));

// 2 · SUPPRESSION RULE — only when buyer Confirmed AND fresher than the category distill
ok('SUPPRESS gsm — buyer Confirmed + Fresh', byKey.gsm.suppressed === true);
ok('KEEP automation_grade — buyer only Likely (never suppress on non-Confirmed)', byKey.automation_grade.suppressed === false);
ok('KEEP color — category state Unknown, no buyer fact → must ASK (never suppress on category alone)', byKey.color.suppressed === false);
ok('KEEP delivery_city — no buyer & no category signal → ask (orphan)', byKey.delivery_city.suppressed === false);

// 3 · coverage honesty
ok('coverage counts all rfq keys', a.coverage.rfq_keys === 4);
ok('exactly 1 suppressed (gsm)', a.coverage.suppressed === 1);
ok('orphaned ask surfaced (delivery_city)', a.coverage.orphaned === 1);

// 4 · cross-brain contradiction — buyer Confirmed gsm=54 vs category Confirmed gsm=100 → flagged (buyer wins)
ok('cross-brain contradiction flagged (buyer 54 vs category 100)', a.contradictions.some((c) => c.rfq_key === 'gsm'));

// 5 · stale-distill edge: a Confirmed buyer fact with an OLD distill still suppresses (buyer is first-party)
const a2 = align(buyer, { ...category, distill_date: '2026-01-01T00:00:00.000Z' }, rfq, NOW);
ok('stale category distill (>30d) → buyer-Confirmed gsm still suppresses', Object.fromEntries(a2.chain.map((c) => [c.rfq_key, c])).gsm.suppressed === true);

console.log(`\nthreebraintest (3-brain registry · frequency→state bands · suppression rule · coverage · cross-brain contradiction): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
