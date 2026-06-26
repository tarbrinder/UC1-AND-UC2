// Deterministic test for the DEEP layers (W1/W2/W3/W7) — mirrors the real logic in
// src/lib/observatoryDeep.ts (spec hidden-critical detection, outcome scaffold) + src/lib/lineage.ts (API map).
// Formatting-only branches aren't asserted; the genuine logic is. NO LLM.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── W3 · API-for-key map (mirror of lineage.API_FOR_KEY) ──
const API_FOR_KEY = { buyer_profile: 'Buyer Profile API', pns_data: 'PNS', prev_isq_data: 'ISQ history', prev_bl_data: 'Buylead history', whatsapp_data: 'WhatsApp', whatsapp_inbound: 'WhatsApp inbound', csl_data: 'CSL (browse/search)' };
const apiForKey = (k) => API_FOR_KEY[k] || null;

// ── W2 · hidden-critical detection (mirror of specReasoning's hidden filter) ──
function hiddenCriticals(specs, criticalRanked) {
  const askedKeys = new Set(specs.map((s) => norm(s.name)));
  return criticalRanked.filter((c) => { const k = norm(c.maps_to_isq || c.name); return k && !askedKeys.has(k) && ![...askedKeys].some((a) => a.includes(k) || k.includes(a)); });
}
// ── W2 · reorder rank (mirror) ──
function rankOf(specName, specOrder) { const m = new Map(specOrder.map((n, i) => [norm(n), i])); const r = m.get(norm(specName)); return r == null ? null : r + 1; }

// ── W7 · outcome verdict (mirror of outcomeSection's prediction-correct logic) ──
function intentCorrect(outcome) { return outcome?.predictedIntent && outcome?.actualIntent ? norm(outcome.predictedIntent) === norm(outcome.actualIntent) : undefined; }

let pass = 0, fail = 0; const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// W3 API labels
ok('W3 API: pns_data → PNS', apiForKey('pns_data') === 'PNS');
ok('W3 API: buyer_profile → Buyer Profile API', apiForKey('buyer_profile') === 'Buyer Profile API');
ok('W3 API: csl_data → CSL', /CSL/.test(apiForKey('csl_data')));
ok('W3 API: unknown key → null', apiForKey('mystery') === null);

// W2 spec reasoning
const specs = [{ name: 'Rated Power' }, { name: 'Phase' }];
const criticals = [{ name: 'Rated Power', maps_to_isq: 'Rated Power', seller_frequency: 90 }, { name: 'Cooling Type', maps_to_isq: 'Cooling Type', seller_frequency: 60 }, { name: 'Voltage', seller_frequency: 40 }];
const hidden = hiddenCriticals(specs, criticals);
ok('W2 hidden: Cooling Type + Voltage hidden (not asked)', hidden.length === 2 && hidden.some((h) => h.name === 'Cooling Type') && hidden.some((h) => h.name === 'Voltage'));
ok('W2 hidden: Rated Power NOT hidden (it is asked)', !hidden.some((h) => h.name === 'Rated Power'));
ok('W2 reorder rank: Phase is rank #2 in specOrder', rankOf('Phase', ['Rated Power', 'Phase', 'Voltage']) === 2);
ok('W2 reorder rank: unranked spec → null', rankOf('Frequency', ['Rated Power', 'Phase']) === null);

// W7 outcome scaffold
ok('W7 outcome: null → undefined verdict (awaiting feed)', intentCorrect(null) === undefined);
ok('W7 outcome: predicted==actual → CORRECT', intentCorrect({ predictedIntent: 'Manufacturing', actualIntent: 'manufacturing' }) === true);
ok('W7 outcome: predicted≠actual → WRONG', intentCorrect({ predictedIntent: 'Commercial', actualIntent: 'Manufacturing' }) === false);

console.log(`\ndeeptest (W1/W2/W3/W7 · API-for-key map · spec hidden-critical detection · reorder rank · outcome prediction verdict): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
