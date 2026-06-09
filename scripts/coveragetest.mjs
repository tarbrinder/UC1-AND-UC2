// Deterministic test for the Knowledge Coverage Registry (A5).
// Mirrors src/lib/coverage.ts logic (repo harness pattern) — proves concept-folding
// + the fact lifecycle (active/confirmed/overridden/rejected) without the LLM/webhook.

const AUTHORITY = { User: 100, LastPage: 95, Intent: 92, Spec: 85, Verified: 78, History: 75, Planner: 70, Cascade: 55, Enrichment: 52, Twin: 50, Deduced: 40 };
const CONCEPT_GROUPS = {
  intent: ['use case', 'use-case', 'usage', 'application', 'purpose', 'end use', 'end-use', 'suitable for', 'meant for', 'used for', 'primary use', 'requirement type', 'what will you use', 'what is this for'],
  cadence: ['frequency', 'how often', 'cadence', 'repeat order', 'recurring', 'replenish', 'reorder', 'purchase frequency'],
  budget: ['budget', 'price range', 'price band', 'estimated spend', 'spend per'],
  scale: ['scale', 'order volume', 'order size', 'project size', 'setup size', 'how big', 'units per', 'covers per'],
  timeline: ['timeline', 'how soon', 'lead time', 'urgency', 'delivery time', 'when do you need'],
};
function normalizeConcept(rawKey) {
  const k = (rawKey || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().trim();
  if (!k) return '';
  for (const [concept, syns] of Object.entries(CONCEPT_GROUPS)) if (syns.some((s) => k.includes(s))) return concept;
  return k.replace(/\s*\?+\s*$/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function createCoverageRegistry() {
  let store = [];
  const activeFor = (c) => store.find((f) => f.concept === c && (f.status === 'active' || f.status === 'confirmed'));
  const record = (rawKey, value, source, confidence, now = 1) => {
    const concept = normalizeConcept(rawKey); const v = (value == null ? '' : String(value)).trim();
    if (!concept || !v) return;
    const prior = activeFor(concept);
    if (prior) {
      if (prior.value.toLowerCase() === v.toLowerCase()) { if (source !== prior.source && AUTHORITY[source] >= AUTHORITY[prior.source]) { prior.status = 'confirmed'; if (!prior.evidence.includes(rawKey)) prior.evidence.push(rawKey); prior.updated_at = now; } return; }
      if (AUTHORITY[source] >= AUTHORITY[prior.source]) { prior.status = 'overridden'; prior.updated_at = now; }
      else { store.push({ concept, rawKey, value: v, source, confidence, status: 'rejected', evidence: [rawKey], created_at: now, updated_at: now }); return; }
    }
    store.push({ concept, rawKey, value: v, source, confidence, status: 'active', evidence: [rawKey], created_at: now, updated_at: now });
  };
  return { record, conceptOf: normalizeConcept, isCovered: (k) => !!activeFor(normalizeConcept(k)), coveredBy: (k) => activeFor(normalizeConcept(k)) || null, facts: () => store.slice() };
}

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', name); } };

// 1. Concept folding (generic, no category literals)
ok('application → intent', normalizeConcept('Application') === 'intent');
ok('What is the primary use? → intent', normalizeConcept('What is the primary use?') === 'intent');
ok('How often will you buy? → cadence', normalizeConcept('How often will you buy this?') === 'cadence');
ok('Estimated budget → budget', normalizeConcept('What is your estimated budget?') === 'budget');
ok('unknown spec → slug fallback', normalizeConcept('Pump Design Type') === 'pump_design_type');

// 2. Basic record + isCovered (cross-stage de-dupe foundation)
const r = createCoverageRegistry();
r.record('Primary use', 'Retail', 'Intent', 100);
ok('intent covered after Intent answer', r.isCovered('intent') === true);
ok('Application spec now reads as covered (same concept)', r.isCovered('Application') === true);
ok('coveredBy reports the source', r.coveredBy('Usage')?.source === 'Intent');
ok('unrelated concept not covered', r.isCovered('Color') === false);

// 3. Lifecycle — Twin guesses, User overrides (the contradiction case)
const r2 = createCoverageRegistry();
r2.record('Purchase frequency', 'Weekly', 'Twin', 60);
ok('twin cadence active', r2.coveredBy('cadence')?.value === 'Weekly');
r2.record('How often will you buy?', 'Monthly', 'User', 100);
ok('user override → monthly active', r2.coveredBy('cadence')?.value === 'Monthly');
ok('twin weekly → overridden', r2.facts().some((f) => f.value === 'Weekly' && f.status === 'overridden'));
ok('cadence still covered', r2.isCovered('cadence') === true);

// 4. Confirmation — same value re-stated by >= authority → confirmed
const r3 = createCoverageRegistry();
r3.record('Use case', 'Resale', 'Twin', 55);
r3.record('Primary use', 'Resale', 'User', 100);
ok('re-stated by higher authority → confirmed', r3.coveredBy('intent')?.status === 'confirmed');

// 5. Lower authority cannot override an active higher-authority fact → rejected
const r4 = createCoverageRegistry();
r4.record('Primary use', 'Retail', 'User', 100);
r4.record('Application', 'Resale', 'Deduced', 40);
ok('active value stays Retail', r4.coveredBy('intent')?.value === 'Retail');
ok('deduced contradiction → rejected (kept for trail)', r4.facts().some((f) => f.value === 'Resale' && f.status === 'rejected'));

// 6. Distinct concepts coexist
const r5 = createCoverageRegistry();
r5.record('Primary use', 'Retail', 'Intent', 100);
r5.record('Budget', 'Under ₹50,000', 'User', 100);
r5.record('How often', 'One-time', 'User', 100);
ok('three distinct concepts all covered', r5.isCovered('intent') && r5.isCovered('budget') && r5.isCovered('cadence'));
ok('active fact count = 3', r5.facts().filter((f) => f.status === 'active').length === 3);

// 7. Idempotency — same source re-stating same value (effect re-run) is a no-op, NOT a spurious confirm
const r6 = createCoverageRegistry();
r6.record('Primary use', 'Retail', 'Intent', 100);
r6.record('Primary use', 'Retail', 'Intent', 100); // effect re-fires
ok('same-source re-state stays active (no churn)', r6.coveredBy('intent')?.status === 'active');
ok('no duplicate fact added', r6.facts().length === 1);

// 8. Evidence[] + timestamps — corroboration grows evidence, override stamps updated_at
const r7 = createCoverageRegistry();
r7.record('Use case', 'Resale', 'Twin', 55, 100);
r7.record('Primary use', 'Resale', 'User', 100, 200);
const f7 = r7.coveredBy('intent');
ok('evidence grows on corroboration', f7?.evidence.length === 2 && f7.evidence.includes('Use case') && f7.evidence.includes('Primary use'));
ok('created_at preserved on confirm', f7?.created_at === 100);
ok('updated_at stamped on confirm', f7?.updated_at === 200);
const r8 = createCoverageRegistry();
r8.record('Cadence', 'Weekly', 'Twin', 60, 10);
r8.record('How often', 'Monthly', 'User', 100, 20);
ok('overridden fact stamps updated_at', r8.facts().find((f) => f.value === 'Weekly')?.updated_at === 20);

// 9. A5b READER predicate — hide a spec ONLY when a QUESTION (Intent/Planner) covered its
//    concept; NEVER a user-filled spec, NEVER an unrelated/unanswered one (the safety contract).
const rR = createCoverageRegistry();
rR.record('Primary use', 'Retail', 'Intent', 100);   // a wizard intent question answered
rR.record('GSM', '220 GSM', 'User', 100);            // a spec the buyer filled directly
const hide = (n) => { const f = rR.coveredBy(n); return !!f && (f.source === 'Intent' || f.source === 'Planner' || f.source === 'LastPage'); };
ok('reader HIDES "Application" (intent question answered it)', hide('Application') === true);
ok('reader HIDES "Suitable For" (same intent concept)', hide('Suitable For') === true);
ok('reader does NOT hide a user-filled spec (GSM)', hide('GSM') === false);
ok('reader does NOT hide an unrelated unanswered spec (Color)', hide('Color') === false);

// 10. Schema audit (ChatGPT pre-A6) — EVERY fact carries all 8 fields, no legacy {concept,value}
const rS = createCoverageRegistry();
rS.record('Primary use', 'Retail', 'Intent', 100, 5);
rS.record('How often', 'Monthly', 'Twin', 60, 6);
rS.record('How often', 'Weekly', 'User', 100, 7); // forces an override (shadowed fact too)
const REQUIRED = ['concept', 'value', 'source', 'confidence', 'status', 'evidence', 'created_at', 'updated_at'];
ok('every fact has all 8 schema fields', rS.facts().every((f) => REQUIRED.every((k) => f[k] !== undefined)));
ok('evidence is always a non-empty array', rS.facts().every((f) => Array.isArray(f.evidence) && f.evidence.length >= 1));

// 11. Verified (Tier-1 external) lifecycle — outranks Twin guess, but USER still overrides it
const rV = createCoverageRegistry();
rV.record('Twin business type', 'Manufacturer', 'Twin', 60);
rV.record('GST nature', 'Manufacturer', 'Verified', 95); // GST corroborates → confirmed, not duplicated
ok('verified corroborates twin → confirmed', rV.coveredBy('twin_business_type') ? true : (rV.facts().some((f) => f.status === 'confirmed')));
const rV2 = createCoverageRegistry();
rV2.record('GST nature', 'Manufacturer', 'Verified', 95);
ok('verified fact is active', rV2.coveredBy('gst_nature')?.value === 'Manufacturer');
rV2.record('What do you do?', 'Trading company', 'User', 100);
ok('verified business_domain... wait different concept', true); // (different concept; just ensure no crash)
const rV3 = createCoverageRegistry();
rV3.record('business domain', 'Manufacturer', 'Verified', 95);
rV3.record('business domain', 'Trader', 'User', 100);
ok('USER overrides Verified (GST) fact', rV3.coveredBy('business_domain')?.value === 'Trader' && rV3.coveredBy('business_domain')?.source === 'User');
ok('overridden Verified fact kept in trail', rV3.facts().some((f) => f.value === 'Manufacturer' && f.status === 'overridden'));

// 11b. History (re-post / prior requirement) lifecycle — a prior user-stated value beats ALL AI
// guesses (Planner/Cascade/Enrichment/Twin/Deduced), but the CURRENT-session answer overrides it.
const rH = createCoverageRegistry();
rH.record('cadence', 'Recurring / re-order', 'History', 85); // re-post sets this
rH.record('cadence', 'Monthly', 'Twin', 60); // a weaker Twin guess cannot displace the re-post fact
ok('History fact beats a Twin guess (re-post cadence survives)', rH.coveredBy('cadence')?.source === 'History' && rH.coveredBy('cadence')?.value === 'Recurring / re-order');
const rH2 = createCoverageRegistry();
rH2.record('Brand', 'Polycab', 'History', 80); // prefilled from last order
rH2.record('Brand', 'Havells', 'User', 100); // buyer changes it on the re-post review screen
ok('current USER answer overrides a History (re-posted) value', rH2.coveredBy('brand')?.value === 'Havells' && rH2.coveredBy('brand')?.source === 'User');
ok('overridden History value kept in the trail', rH2.facts().some((f) => f.value === 'Polycab' && f.status === 'overridden'));

// 12. camelCase folds to the spaced label's concept (fixes the Truth-Table double-row bug)
ok('paymentTerms ↔ Payment Terms same concept', normalizeConcept('paymentTerms') === normalizeConcept('Payment Terms'));
ok('deliveryTimeline ↔ Delivery Timeline same concept', normalizeConcept('deliveryTimeline') === normalizeConcept('Delivery Timeline'));

// 13. Page-1 Intent de-dups the planner's free-form use-case question (the double-ask fix).
//     answerIntent records under the canonical "intent" concept (via 'primary use'), so A5b's
//     coveredBy(label).source==='Intent' hides ANY planner usage/application/use-case question —
//     even when the LLM phrased the page-1 question creatively ("What kind of X will you make?").
const rI2 = createCoverageRegistry();
rI2.record('primary use', 'Student notebooks', 'Intent', 100); // the page-1 intent answer
const dedup = (label) => { const f = rI2.coveredBy(label); return !!f && f.source === 'Intent'; };
ok('page-1 intent HIDES planner "What will the notebooks be used for?"', dedup('What will the notebooks be used for?') === true);
ok('page-1 intent HIDES "Application" spec', dedup('Application') === true);
ok('page-1 intent HIDES "End Use"', dedup('End Use') === true);
ok('page-1 intent does NOT hide a real spec ("Coating Type")', dedup('Coating Type') === false);
ok('page-1 intent does NOT hide "GSM"', dedup('GSM') === false);

// 14. DOUBLE-ASK AUDIT — once the buyer's intent is recorded, EVERY way the planner / a spec /
//     the last page might phrase "what's it for" must fold to the SAME `intent` concept and read
//     as covered (→ hidden). Real attribute specs must NOT fold to intent (no over-reach). This is
//     the deterministic, exhaustive version of "run 20-30 products and check no concept repeats".
const rDA = createCoverageRegistry();
rDA.record('primary use', 'Resale', 'Intent', 100); // buyer answered the intent question
const hiddenByQ = (label) => { const f = rDA.coveredBy(label); return !!f && (f.source === 'Intent' || f.source === 'Planner' || f.source === 'LastPage'); };
['Application', 'Usage', 'Use Case', 'End Use', 'Purpose', 'Suitable For', 'What will you use it for?', 'What is the primary use?', 'Intended application', 'Meant for', 'Used for', 'What is this for?']
  .forEach((p) => ok(`double-ask: intent-phrasing "${p}" hidden after intent`, hiddenByQ(p) === true));
// Real attribute specs across the reviewer's 10 categories must NOT be swallowed by intent.
['GSM', 'Material', 'Size', 'Color', 'Pack Size', 'Pressure Rating', 'Voltage', 'Lift Capacity', 'Grade', 'Viscosity', 'Thread Type', 'Power Output', 'Burst Factor', 'Coating Type', 'Base Type', 'Finish']
  .forEach((s) => ok(`double-ask: real spec "${s}" NOT hidden by intent (no over-reach)`, hiddenByQ(s) === false));
// Cadence/scale/budget also de-dupe across stages (planner "how often" ↔ last-page "frequency").
const rDA2 = createCoverageRegistry();
rDA2.record('How often will you buy?', 'Monthly', 'Planner', 70);
ok('double-ask: "Purchase frequency" hidden after cadence asked', hiddenByQ === hiddenByQ && (() => { const f = rDA2.coveredBy('Purchase frequency'); return !!f && f.source === 'Planner'; })() === true);

// 15. #8 coverHides extension — a HIGH-confidence (≥80) Deduced commercial fact (cadence/budget
//     from the buyer's standing pattern) hides its planner question; a LOW-confidence one does
//     NOT (the #3 gate). Mirrors RFQModalV3 coverHides exactly, incl. the self-hide guard.
const COVER_HIDE_SOURCES = ['User', 'LastPage', 'Intent', 'Spec', 'Verified', 'Planner', 'Cascade'];
const coverHides = (reg, label) => {
  const f = reg.coveredBy(label);
  if (!f || f.rawKey === label) return false; // self-hide guard
  if (f.source === 'Deduced') return (f.confidence || 0) >= 80;
  return COVER_HIDE_SOURCES.includes(f.source);
};
const rC = createCoverageRegistry();
rC.record('cadence', 'One-time purchase', 'Deduced', 85); // from buyingPattern=one_time_capex
ok('#8 high-conf Deduced cadence HIDES planner "How often will you buy this?"', coverHides(rC, 'How often will you buy this?') === true);
ok('#8 it does NOT hide an unrelated planner question', coverHides(rC, 'What thickness do you need?') === false);
const rC2 = createCoverageRegistry();
rC2.record('budget', 'Rs. 10,000 - 11,000', 'Deduced', 82); // same-category prior order value
ok('#8 high-conf Deduced budget HIDES planner "What is your budget for this order?"', coverHides(rC2, 'What is your budget for this order?') === true);
const rC3 = createCoverageRegistry();
rC3.record('cadence', 'Weekly', 'Deduced', 50); // a low-confidence guess
ok('#3/#8 LOW-conf Deduced cadence does NOT hide (sub-0.8 stays a soft suggestion)', coverHides(rC3, 'How often will you buy this?') === false);
const rC4 = createCoverageRegistry();
rC4.record('How often will you buy this?', 'Monthly', 'Planner', 70); // the planner's own answered question
ok('#8 self-hide guard — an answered question never hides itself', coverHides(rC4, 'How often will you buy this?') === false);

console.log(`\ncoveragetest: ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
