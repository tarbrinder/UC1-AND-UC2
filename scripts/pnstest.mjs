// Deterministic test for PNS Call Cards (Wave 2B · mirrors pnsCards.ts).
// Proves: flat per-call PNS facts → one card per call, with persona/summary/need/intent/order/questions/
// products/blockers + a signals strip + the raw facts for transcript drill. NO LLM.

function buildPnsCards(facts) {
  const pns = facts.filter((f) => f.sourceNode === 'pns-insights');
  if (!pns.length) return [];
  const order = []; const byCall = new Map();
  for (const f of pns) { const c = f.lineRef || 'call ?'; if (!byCall.has(c)) { byCall.set(c, []); order.push(c); } byCall.get(c).push(f); }
  const first = (fs, tag) => fs.find((f) => f.tag === tag)?.rawValue;
  const allOf = (fs, tag) => [...new Set(fs.filter((f) => f.tag === tag).map((f) => f.rawValue))];
  return order.map((c) => { const fs = byCall.get(c); const persona = first(fs, 'pns.persona'); const orderType = first(fs, 'pns.order_type'); const qtyScale = first(fs, 'pns.qty_scale'); const intent = first(fs, 'pns.intent_level'); const signals = []; if (persona) signals.push({ label: 'Persona', value: persona }); if (orderType) signals.push({ label: 'Order', value: orderType }); if (qtyScale) signals.push({ label: 'Scale', value: qtyScale }); if (intent) signals.push({ label: 'Intent', value: intent }); return { call: c, persona, application: first(fs, 'pns.application'), intent, orderType, qtyScale, language: first(fs, 'pns.language'), summary: first(fs, 'pns.narrative'), products: allOf(fs, 'pns.product'), questions: allOf(fs, 'pns.seller_q'), blockers: allOf(fs, 'pns.blocker'), signals, raw: fs }; });
}

const F = (tag, rawValue, lineRef) => ({ sourceNode: 'pns-insights', tag, rawValue, lineRef });
const facts = [
  F('pns.persona', 'Manufacturer', 'call 1'), F('pns.application', 'Notebook Manufacturing', 'call 1'), F('pns.intent_level', 'High', 'call 1'),
  F('pns.order_type', 'Bulk', 'call 1'), F('pns.narrative', 'Seeking raw material for notebook manufacturing.', 'call 1'),
  F('pns.product', 'Writing Paper', 'call 1'), F('pns.seller_q', 'How much quantity do you need?', 'call 1'),
  F('pns.persona', 'Entrepreneur', 'call 2'), F('pns.narrative', 'new notebook business venture', 'call 2'),
  F('pns.seller_q', 'Are you setting up a manufacturing unit?', 'call 2'), F('pns.seller_q', 'Have you installed the machines?', 'call 2'),
  F('pns.blocker', 'Stock confirmation pending', 'call 2'),
  { sourceNode: 'prev-bl', tag: 'bl.title', rawValue: 'X', lineRef: 'BL 1' }, // must be ignored (not PNS)
];
const cards = buildPnsCards(facts);

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

ok('one card per call (2), non-PNS ignored', cards.length === 2 && cards.every((c) => c.call.startsWith('call')));
ok('card 1 fields picked (persona/application/intent/order/summary)', cards[0].persona === 'Manufacturer' && cards[0].application === 'Notebook Manufacturing' && cards[0].intent === 'High' && cards[0].orderType === 'Bulk' && /raw material/i.test(cards[0].summary));
ok('card 1 products + questions captured', cards[0].products.includes('Writing Paper') && cards[0].questions.length === 1);
ok('card 1 signals strip (persona+order+intent)', cards[0].signals.some((s) => s.value === 'Manufacturer') && cards[0].signals.some((s) => s.value === 'Bulk') && cards[0].signals.some((s) => s.value === 'High'));
ok('card 2 = Entrepreneur with 2 seller questions + a blocker', cards[1].persona === 'Entrepreneur' && cards[1].questions.length === 2 && cards[1].blockers.length === 1);
ok('raw facts kept per card (transcript drill)', cards[0].raw.length === 7 && cards[0].raw.every((f) => f.sourceNode === 'pns-insights'));
ok('summary present per call (the human one-liner)', cards.every((c) => c.summary && c.summary.length > 0));

console.log(`\npnstest (Wave 2B · PNS call cards · group-by-call · persona/summary/need/questions/products/signals · transcript drill): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
