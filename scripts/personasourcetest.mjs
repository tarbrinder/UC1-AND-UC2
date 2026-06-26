// Deterministic test for P0.2 SOURCE-AWARE PERSONA — mirrors the manualLogistics guard in
// RFQModalV3 + distillSessionBehavior's commercial/urgency posture (src/lib/enrichment.ts).
// The rule: behaviour reshapes ONLY from the buyer's OWN actions. An AUTO-DEDUCED logistics value
// must NOT create a behaviour trait (the circular "deduced Credit → seeks credit terms" bug).

// --- the guard (mirrors the form) ---
function manualLogistics(deducedLogistics, id, val) {
  const d = deducedLogistics[id];
  const autoFilled = !!d && (d.confidence ?? 0) >= 0.8 && String(val).trim() === String(d.value || '').trim();
  return autoFilled ? '' : val;
}
// --- the posture interpreters (mirror distillSessionBehavior) ---
function commercialPosture(paymentTerms) {
  const pt = (paymentTerms || '').toLowerCase();
  if (!pt) return null; // no trait
  return /advance/.test(pt) ? 'Advance-led' : /credit|post.?delivery|net ?\d/.test(pt) ? 'Credit-seeking' : /loan|finance|emi/.test(pt) ? 'Finance-seeking' : /cod|cash/.test(pt) ? 'COD' : 'Stated';
}
function urgencyPosture(deliveryTimeline) {
  const dt = (deliveryTimeline || '').toLowerCase();
  if (!dt) return null;
  return /immediate|urgent|today|asap|24 ?h|same.?day/.test(dt) ? 'Immediate' : /flex|no rush|anytime|whenever/.test(dt) ? 'Flexible' : 'Planned';
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ════ THE CIRCULAR BUG (Jaiveer): payment auto-deduced Credit (95%) → must NOT become a trait ════
const deduced = { paymentTerms: { value: 'Credit (Post-Delivery)', confidence: 0.95, reason: 'recurring' }, deliveryTimeline: { value: 'Within 15 Days', confidence: 0.8, reason: 'recurring' } };
ok('auto-deduced Credit → manualLogistics suppresses it (empty)', manualLogistics(deduced, 'paymentTerms', 'Credit (Post-Delivery)') === '');
ok('→ commercial_posture is NULL (no "seeks credit terms")', commercialPosture(manualLogistics(deduced, 'paymentTerms', 'Credit (Post-Delivery)')) === null);
ok('auto-deduced delivery → urgency_posture NULL (not "Planned" from a guess)', urgencyPosture(manualLogistics(deduced, 'deliveryTimeline', 'Within 15 Days')) === null);

// ════ MANUAL pick → DOES shape behaviour (the buyer really chose it) ════
const noDeduce = {};
ok('manual Credit pick → commercial_posture = Credit-seeking', commercialPosture(manualLogistics(noDeduce, 'paymentTerms', 'Credit (Post-Delivery)')) === 'Credit-seeking');
ok('manual Advance pick → Advance-led', commercialPosture(manualLogistics(noDeduce, 'paymentTerms', 'Advance')) === 'Advance-led');
ok('manual urgent delivery → Immediate', urgencyPosture(manualLogistics(noDeduce, 'deliveryTimeline', 'Immediate / Urgent')) === 'Immediate');

// ════ buyer CHANGED the deduced value → counts as manual (differs from the deduced value) ════
ok('buyer overrode deduced Credit → Advance → posture follows the OVERRIDE (Advance-led)', commercialPosture(manualLogistics(deduced, 'paymentTerms', 'Advance')) === 'Advance-led');
ok('buyer changed deduced delivery → Immediate → urgency Immediate', urgencyPosture(manualLogistics(deduced, 'deliveryTimeline', 'Immediate')) === 'Immediate');

// ════ a LOW-confidence deduce (<0.8 = it was ASKED, not auto-applied) → counts as the buyer's answer ════
const lowConf = { paymentTerms: { value: 'Credit (Post-Delivery)', confidence: 0.6, reason: 'unsure → asked' } };
ok('low-conf (<0.8) payment was asked, not auto-filled → posture set (the buyer answered)', commercialPosture(manualLogistics(lowConf, 'paymentTerms', 'Credit (Post-Delivery)')) === 'Credit-seeking');

// ════ spec/persona engagement traits are ALREADY manual-only (manualSpecs/overrides) — unaffected ════
ok('no payment at all → no commercial_posture (graceful)', commercialPosture(manualLogistics({}, 'paymentTerms', '')) === null);

console.log(`\npersonasourcetest (P0.2: auto-deduced logistics never reshapes behaviour · manual pick does · override counts · low-conf-asked counts · no self-learning): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
