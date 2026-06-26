// Deterministic test for the Requirement-Brain RESOLVER (Phase 1 · src/lib/requirementBrain.ts).
// The brains (Buyer + Category) come from n8n; the resolver turns them + live form state into the
// ephemeral Requirement Brain. The STAR assertion is ChatGPT's guardrail: never ask what's known.
// NO LLM, NO network — mirrors the resolver.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
function parseRequirementBrain(raw) {
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? [raw] : []);
  for (const item of arr) { const rb = item && typeof item === 'object' ? item.requirement_brain : undefined; if (rb && typeof rb === 'object') return rb; }
  return null;
}
function resolveRequirement(brain, ctx) {
  const empty = { specOrder: [...(ctx?.isqSpecNames || [])], addedSpecs: [], ask: [], knownDropped: [], criticalRanked: [], registryFacts: [], knownInSchema: [] };
  if (!brain) return empty;
  const critical = (brain.category_intelligence?.critical_specs || brain.planner_input?.category_critical_specs || []).filter((c) => c && (c.name || c.maps_to_isq));
  const criticalRanked = [...critical].sort((a, b) => (b.seller_frequency ?? 0) - (a.seller_frequency ?? 0));
  const known = new Set([...(brain.buyer_intelligence?.known_specs || []), ...(brain.buyer_intelligence?.known_intent || []), ...(ctx.answeredSpecNames || [])].map(norm));
  const freq = new Map(); for (const c of criticalRanked) freq.set(norm(c.maps_to_isq || c.name), c.seller_frequency ?? 50);
  const isqRanked = [...(ctx.isqSpecNames || [])].sort((a, b) => (freq.get(norm(b)) ?? -1) - (freq.get(norm(a)) ?? -1));
  const isqSet = new Set((ctx.isqSpecNames || []).map(norm));
  const addedSpecs = criticalRanked.filter((c) => { const k = norm(c.maps_to_isq || c.name); return k && !isqSet.has(k); }).map((c) => c.name);
  const answeredSet = new Set((ctx.answeredSpecNames || []).map(norm));
  const knownInSchema = [...(brain.buyer_intelligence?.known_specs || [])].filter((k) => isqSet.has(norm(k)) && !answeredSet.has(norm(k)));
  const followups = (brain.category_intelligence?.common_followups || [])
    .map((f) => (typeof f === 'string' ? f : (f && typeof f === 'object' ? (f.question || f.maps_to_spec || '') : '')))
    .filter(Boolean);
  const askCandidates = [...criticalRanked.map((c) => c.maps_to_isq || c.name), ...followups].filter(Boolean);
  const seen = new Set(); const ask = []; const knownDropped = [];
  for (const cand of askCandidates) { const k = norm(cand); if (!k || seen.has(k)) continue; seen.add(k); (known.has(k) ? knownDropped : ask).push(cand); }
  return { specOrder: [...addedSpecs, ...isqRanked], addedSpecs, ask, knownDropped, criticalRanked, registryFacts: brain.facts || [], knownInSchema };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── parse from the webhook array (the appended requirement_brain item) ──
ok('parse: finds requirement_brain in a per-source array', !!parseRequirementBrain([{ csl_data: '[]' }, { requirement_brain: { facts: [] } }]));
ok('parse: returns null when absent (form degrades gracefully)', parseRequirementBrain([{ csl_data: '[]' }, { pns_data: '[]' }]) === null);
ok('parse: null on junk', parseRequirementBrain(null) === null && parseRequirementBrain('x') === null);

// ════ THE GUARDRAIL — ChatGPT's 125-kVA example: never ask what's known ════
const dgBrain = {
  category_intelligence: { critical_specs: [
    { name: 'kVA', seller_frequency: 92, maps_to_isq: 'kVA' },
    { name: 'Phase', seller_frequency: 81, maps_to_isq: 'Phase' },
    { name: 'Runtime', seller_frequency: 64, maps_to_isq: 'Runtime' },
  ], common_followups: ['Location Preference', 'Delivery Timeline'] },
  buyer_intelligence: { known_specs: [], known_intent: ['factory backup'] },
};
const dg = resolveRequirement(dgBrain, { isqSpecNames: ['Phase', 'Runtime', 'kVA', 'Fuel Type'], answeredSpecNames: ['kVA'], intentKnown: true });
ok('GUARDRAIL: buyer said 125 kVA → kVA is NOT asked', !dg.ask.includes('kVA'));
ok('GUARDRAIL: kVA shows in knownDropped (proves subtraction fired)', dg.knownDropped.includes('kVA'));
ok('GUARDRAIL: still asks Phase + Runtime (the real gaps)', dg.ask.includes('Phase') && dg.ask.includes('Runtime'));
ok('GUARDRAIL: common_followups carried into ask (Location/Delivery)', dg.ask.includes('Location Preference') && dg.ask.includes('Delivery Timeline'));

// ── REPRIORITISE: ISQ specs ranked by seller_frequency (criticals float up) ──
ok('reprioritise: kVA (92) ranks above Fuel Type (uncritical) in specOrder', dg.specOrder.indexOf('kVA') < dg.specOrder.indexOf('Fuel Type'));
ok('reprioritise: Phase (81) ranks above Runtime (64)', dg.specOrder.indexOf('Phase') < dg.specOrder.indexOf('Runtime'));

// ── ADD: a critical spec missing from the ISQ schema is added at top ──
const addBrain = { category_intelligence: { critical_specs: [{ name: 'CPCB Compliance', seller_frequency: 70, maps_to_isq: 'CPCB Compliance' }, { name: 'kVA', seller_frequency: 92 }] } };
const add = resolveRequirement(addBrain, { isqSpecNames: ['kVA', 'Phase'], answeredSpecNames: [], intentKnown: false });
ok('add: critical "CPCB Compliance" not in ISQ → added', add.addedSpecs.includes('CPCB Compliance'));
ok('add: an existing ISQ critical (kVA) is NOT re-added', !add.addedSpecs.includes('kVA'));
ok('add: added specs sit at the TOP of specOrder', add.specOrder[0] === 'CPCB Compliance');

// ── known via buyer history (not just live answers) also suppresses ──
const histBrain = { category_intelligence: { critical_specs: [{ name: 'Automation Grade', maps_to_isq: 'Automation Grade' }, { name: 'Cutting Size', maps_to_isq: 'Cutting Size' }] }, buyer_intelligence: { known_specs: ['Automation Grade'] } };
const hist = resolveRequirement(histBrain, { isqSpecNames: ['Automation Grade', 'Cutting Size'], answeredSpecNames: [], intentKnown: false });
ok('history-known: prior "Automation Grade" is dropped from ask', !hist.ask.includes('Automation Grade') && hist.knownDropped.includes('Automation Grade'));
ok('history-known: still asks the genuinely-open "Cutting Size"', hist.ask.includes('Cutting Size'));

// ── facts pass through for the registry ──
const factBrain = { facts: [{ source: 'pns', type: 'intent', key: 'application', value: 'Notebook Manufacturing', confidence: 90 }], category_intelligence: null };
ok('facts: registryFacts carries the PNS intent fact (the goldmine)', resolveRequirement(factBrain, { isqSpecNames: [], answeredSpecNames: [] }).registryFacts[0].value === 'Notebook Manufacturing');

// ── degrade gracefully ──
ok('no brain → specOrder = ISQ unchanged, empty ask (form behaves as today)', (() => { const r = resolveRequirement(null, { isqSpecNames: ['A', 'B'], answeredSpecNames: [] }); return r.specOrder.join() === 'A,B' && r.ask.length === 0; })());
ok('brain with no category → no adds, no asks, ISQ order preserved', (() => { const r = resolveRequirement({ buyer_intelligence: { known_specs: [] }, category_intelligence: null }, { isqSpecNames: ['A', 'B'], answeredSpecNames: [] }); return r.addedSpecs.length === 0 && r.ask.length === 0; })());
ok('no double-ask: a critical that is also a followup appears once', (() => { const r = resolveRequirement({ category_intelligence: { critical_specs: [{ name: 'Budget' }], common_followups: ['Budget'] } }, { isqSpecNames: [], answeredSpecNames: [] }); return r.ask.filter((x) => norm(x) === norm('Budget')).length === 1; })());

// ════ v13 SHAPE: cat_store derives common_followups as {question, maps_to_spec, frequency} OBJECTS ════
// (not strings). The resolver must normalize to the question text — never push "[object Object]" into ask.
const v13Followups = resolveRequirement({ category_intelligence: { critical_specs: [{ name: 'kVA', seller_frequency: 90 }], common_followups: [{ question: 'What is your budget range?', maps_to_spec: 'Budget', frequency: 'high' }, { question: 'Delivery location?', maps_to_spec: 'Location', frequency: 'medium' }] } }, { isqSpecNames: ['kVA'], answeredSpecNames: [], intentKnown: false });
ok('v13 OBJECT followups: normalized to question text in ask (no "[object Object]")', v13Followups.ask.includes('What is your budget range?') && v13Followups.ask.includes('Delivery location?'));
ok('v13 OBJECT followups: ask never contains "[object Object]"', !v13Followups.ask.some((x) => /\[object Object\]/.test(String(x))));
ok('v13 OBJECT followups: falls back to maps_to_spec when question is empty', resolveRequirement({ category_intelligence: { critical_specs: [], common_followups: [{ question: '', maps_to_spec: 'Phase' }] } }, { isqSpecNames: [], answeredSpecNames: [] }).ask.includes('Phase'));
ok('v13 OBJECT followups: a known object-followup is still suppressed (subtraction works on the text)', !resolveRequirement({ category_intelligence: { critical_specs: [], common_followups: [{ question: 'Budget' }] }, buyer_intelligence: { known_specs: ['Budget'] } }, { isqSpecNames: [], answeredSpecNames: [] }).ask.includes('Budget'));

// ════ BUYER MEMORY works WITHOUT category (the Amit case: re-RFQ antique doors, category cold) ════
const amitBrain = { category_intelligence: null, buyer_intelligence: { known_specs: ['Material', 'Door Type', 'Style', 'Application', 'With Frame (Chaukhat)', 'Condition'] } };
const amit = resolveRequirement(amitBrain, { isqSpecNames: ['Material', 'Door Type', 'Style', 'Application', 'With Frame (Chaukhat)', 'Condition', 'Size'], answeredSpecNames: [], intentKnown: false });
ok('BUYER MEMORY: 6 prior specs that are in the ISQ schema → knownInSchema (no category needed)', amit.knownInSchema.length === 6);
ok('BUYER MEMORY: a NEW schema field (Size) the buyer never answered is NOT in knownInSchema', !amit.knownInSchema.map(norm).includes(norm('Size')));
ok('BUYER MEMORY: works even though category_intelligence is null (criticals empty)', amit.criticalRanked.length === 0 && amit.knownInSchema.length > 0);
ok('BUYER MEMORY: a spec answered THIS session drops out of knownInSchema (already handled live)', resolveRequirement(amitBrain, { isqSpecNames: ['Material', 'Door Type'], answeredSpecNames: ['Material'], intentKnown: false }).knownInSchema.join() === 'Door Type');
ok('BUYER MEMORY: no brain → empty knownInSchema', resolveRequirement(null, { isqSpecNames: ['A'], answeredSpecNames: [] }).knownInSchema.length === 0);

console.log(`\nrequirementbraintest (Phase 1 resolver · subtraction guardrail "never ask what's known" · reprioritise · add · facts · buyer-memory-without-category · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
