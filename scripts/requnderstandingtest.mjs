// Deterministic test for the Requirement Understanding ("Final RFQ Vision") foundation (Phase 2/3).
// Mirrors RFQModalV3.tsx requirementUnderstanding() — the trait→dimension maps + the gap behaviour
// (a dimension with no value renders "— (phase 2)" at confidence 0). NO LLM, NO network.

const RU_AWARENESS = { spec_driven: 'Specification-driven', brand_driven: 'Brand-driven', catalog_driven: 'Catalog / price-driven', application_driven: 'Solution-driven' };
const RU_SUPPORT = { 'Needs Guidance': 'Needs consultation', 'Self Driven': 'Self-sufficient', Hybrid: 'Some guidance' };
const RU_COMMS = { 'WhatsApp Friendly': 'WhatsApp-first', 'Image Sharing Buyer': 'WhatsApp-first (images)', 'Call First Buyer': 'Phone-first', 'Low Response Buyer': 'Low engagement' };

// add(): the gap rule — empty value ⇒ "— (phase 2)" at 0 confidence + source "—".
const add = (value, confidence, source) => ({ value: value || '— (phase 2)', confidence: value ? confidence : 0, source: value ? source : '—' });
const mapVia = (table, key) => (key ? table[key] || key : '');

// Assemble the dimensions the way the component does, from a profile + (optional) twin.
function requirementUnderstanding(bp = {}, tw = {}, opts = {}) {
  const lb = tw.layer_b_behavioral || {};
  const lc = tw.layer_c_commercial_intelligence || {};
  const out = {};
  out['Who is the buyer'] = add([opts.role, bp.maturity].filter(Boolean).join(' · '), opts.role ? (opts.userRole ? 100 : 85) : 0, opts.userRole ? 'User' : 'Twin/Profile');
  const curIntent = opts.currentIntent || '';
  const ai = lc.current_active_intent;
  out['Use case / intent'] = add(curIntent || String((ai && ai.value) || ''), curIntent ? 100 : (ai && ai.confidence) || 0, curIntent ? 'User' : 'Twin');
  out['Procurement stage'] = add(bp.maturity || '', bp.maturity ? 85 : 0, 'Profile');
  const urg = opts.mode === 'emergency' ? 'Immediate' : /low tolerance/i.test(String(bp.responseSensitivity || '')) ? 'Soon' : opts.repeat ? 'Recurring cadence' : '';
  out['Purchase urgency'] = add(urg, urg ? 55 : 0, 'Mode/Twin (inferred)');
  const power = String((lc.bulk_orientation && lc.bulk_orientation.value) || '') || opts.scale || '';
  out['Purchasing power'] = add(power ? `${power} (band)` : '', power ? 50 : 0, 'History/Twin');
  const loc = String((lb.local_preference && lb.local_preference.value) || '') || bp.localityPreference || '';
  out['Local supplier preference'] = add(loc, loc ? 70 : 0, 'Twin/Profile');
  out['Buyer awareness'] = add(mapVia(RU_AWARENESS, bp.sourcingStyle), bp.sourcingStyle ? 70 : 0, 'Profile');
  const comm = bp.engagement ? mapVia(RU_COMMS, bp.engagement) : ((lb.whatsapp_affinity && lb.whatsapp_affinity.value) ? 'WhatsApp-first' : '');
  out['Preferred communication'] = add(comm, comm ? 75 : 0, 'Twin/Profile');
  out['Support required'] = add(mapVia(RU_SUPPORT, bp.decisionStyle), bp.decisionStyle ? 60 : 0, 'Profile');
  return out;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// trait → dimension maps
ok('sourcingStyle spec_driven → Specification-driven', RU_AWARENESS['spec_driven'] === 'Specification-driven');
ok('decisionStyle "Needs Guidance" → Needs consultation', RU_SUPPORT['Needs Guidance'] === 'Needs consultation');
ok('decisionStyle "Self Driven" → Self-sufficient', RU_SUPPORT['Self Driven'] === 'Self-sufficient');
ok('engagement "WhatsApp Friendly" → WhatsApp-first', RU_COMMS['WhatsApp Friendly'] === 'WhatsApp-first');
ok('unknown trait value → passthrough (never blank)', mapVia(RU_AWARENESS, 'some_new_style') === 'some_new_style');

// gap behaviour: a missing trait → "— (phase 2)" at 0 confidence
ok('missing trait → "— (phase 2)" + conf 0 + source —', (() => { const r = add('', 70, 'Profile'); return r.value === '— (phase 2)' && r.confidence === 0 && r.source === '—'; })());

// The notebook-paper buyer (the live case) — assemble + check the known dimensions resolve.
const bp = { maturity: 'Execution Phase', sourcingStyle: 'spec_driven', decisionStyle: 'Self Driven', engagement: 'WhatsApp Friendly', localityPreference: 'Regional', responseSensitivity: 'Low Tolerance For Delay' };
const tw = { layer_c_commercial_intelligence: { current_active_intent: { value: 'Notebook Manufacturing Inputs', confidence: 90 } } };
const ru = requirementUnderstanding(bp, tw, { role: 'Manufacturer', repeat: true });
ok('notebook buyer: stage = Execution Phase', ru['Procurement stage'].value === 'Execution Phase');
ok('notebook buyer: awareness = Specification-driven', ru['Buyer awareness'].value === 'Specification-driven');
ok('notebook buyer: comms = WhatsApp-first', ru['Preferred communication'].value === 'WhatsApp-first');
ok('notebook buyer: support = Self-sufficient', ru['Support required'].value === 'Self-sufficient');
ok('notebook buyer: local pref = Regional', ru['Local supplier preference'].value === 'Regional');
ok('notebook buyer: urgency = Soon (low delay tolerance)', ru['Purchase urgency'].value === 'Soon');
ok('notebook buyer: use-case falls back to Twin active-intent', ru['Use case / intent'].value === 'Notebook Manufacturing Inputs' && ru['Use case / intent'].source === 'Twin');
ok('notebook buyer: CURRENT intent overrides Twin when present', requirementUnderstanding(bp, tw, { role: 'Manufacturer', currentIntent: 'Raw paper for notebook manufacturing' })['Use case / intent'].source === 'User');
ok('notebook buyer: who = role · stage', ru['Who is the buyer'].value === 'Manufacturer · Execution Phase');

// A COLD buyer (no twin, no profile) → most dims are honest phase-2 gaps, none crash.
const cold = requirementUnderstanding({}, {}, {});
ok('cold buyer: every dimension present (no crash)', Object.keys(cold).length === 9);
ok('cold buyer: stage is a phase-2 gap', cold['Procurement stage'].value === '— (phase 2)' && cold['Procurement stage'].confidence === 0);

console.log(`\nrequnderstandingtest (Requirement Understanding / Final RFQ Vision foundation): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
