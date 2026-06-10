// Contract test for BTE-v1.3 — OBSERVED in-session RFQ-filling behaviour (Scope 1).
// Mirrors distillSessionBehavior + mergeObservedBehavior in src/lib/enrichment.ts (repo harness
// pattern: re-implement the pure logic inline, no TS import, no LLM, no webhook).
//
// The thesis: HOW a buyer fills the form is first-party behavioural truth. We distil it into
// traits that DESCRIBE the buyer (lowest in the decision hierarchy — never override the current
// requirement), source-separated from history (evidence = [rfq_session]), confidence-capped
// because one session is weak, and STRENGTHENED across sessions by the merge.

const AT = '2026-06-09T10:00:00.000Z';

function distill(inp) {
  const at = inp.observedAt || AT;
  const ev = (signal) => [{ source: 'rfq_session', date: at.slice(0, 10), signal }];
  const trait = (value, confidence, stability, signal, contradictions = 0) => ({
    value,
    confidence: Math.min(60, Math.max(0, Math.round(confidence))),       // single-session cap 60
    trait_stability: Math.min(60, Math.max(0, Math.round(stability))),
    contradictions_count: contradictions,
    last_seen: at.slice(0, 10),
    evidence: ev(signal),
  });
  const out = { session_count: 1, observed_at: at };

  const ratio = inp.specsAvailable > 0 ? inp.specsFilledByUser / inp.specsAvailable : 0;
  const handsOn = inp.specsFilledByUser + inp.personaQsAnswered;
  if (handsOn >= 1) {
    const conf = 35 + Math.min(20, inp.specsAvailable * 2);
    const sig = `filled ${inp.specsFilledByUser}/${inp.specsAvailable} + ${inp.personaQsAnswered} Q`;
    if (ratio >= 0.5 || inp.specsFilledByUser >= 6) out.spec_engagement = trait('High', conf, 30, sig);
    else if (ratio >= 0.2 || inp.specsFilledByUser >= 2) out.spec_engagement = trait('Medium', conf - 5, 28, sig);
    else out.spec_engagement = trait('Low', conf - 10, 26, sig);
  }
  if (inp.specsRemoved >= 1) {
    out.flexibility = trait(inp.specsRemoved >= 2 ? 'High' : 'Medium', 30 + inp.specsRemoved * 6, 28, `removed ${inp.specsRemoved}`);
  }
  const qTotal = inp.personaQsAnswered + inp.personaQsSkipped;
  if (qTotal >= 1) {
    if (inp.personaQsSkipped > 0 && inp.personaQsAnswered === 0) out.question_engagement = trait('Low', 40, 30, 'skipped');
    else if (inp.personaQsAnswered >= 2 && inp.personaQsSkipped === 0) out.question_engagement = trait('High', 45, 32, 'answered');
    else out.question_engagement = trait('Medium', 38, 28, 'mixed');
  }
  const dt = (inp.deliveryTimeline || '').toLowerCase();
  if (dt) {
    const val = /immediate|urgent|today|asap|24 ?h|same.?day/.test(dt) ? 'Immediate'
      : /flex|no rush|anytime|whenever/.test(dt) ? 'Flexible' : 'Planned';
    out.urgency_posture = trait(val, 50, 35, dt);
  }
  const pt = (inp.paymentTerms || '').toLowerCase();
  if (pt) {
    const val = /advance/.test(pt) ? 'Advance-led'
      : /credit|post.?delivery|net ?\d/.test(pt) ? 'Credit-seeking'
      : /loan|finance|emi/.test(pt) ? 'Finance-seeking'
      : /cod|cash/.test(pt) ? 'COD' : 'Stated';
    out.commercial_posture = trait(val, 50, 35, pt);
  }
  if (inp.specsOverridden >= 1) {
    out.independence = trait(inp.specsOverridden >= 2 ? 'High' : 'Medium', 35 + inp.specsOverridden * 6, 28, `overrode ${inp.specsOverridden}`);
  }
  return out;
}

function merge(prior, curr) {
  if (!prior) return curr;
  const keys = ['spec_engagement', 'flexibility', 'question_engagement', 'urgency_posture', 'commercial_posture', 'independence'];
  const m = { session_count: (prior.session_count || 1) + 1, observed_at: curr.observed_at };
  for (const k of keys) {
    const p = prior[k], c = curr[k];
    if (p && c) {
      const same = String(p.value) === String(c.value);
      m[k] = {
        value: c.value,
        confidence: Math.min(75, Math.round(same ? Math.max(p.confidence, c.confidence) + 8 : (p.confidence + c.confidence) / 2)),
        trait_stability: same ? Math.min(85, p.trait_stability + 15) : Math.max(20, p.trait_stability - 12),
        contradictions_count: p.contradictions_count + (same ? 0 : 1),
        last_seen: c.last_seen,
        evidence: [...p.evidence, ...c.evidence].slice(-6),
      };
    } else {
      m[k] = c || p;
    }
  }
  return m;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── the live diesel-generator case (GLID on screen) ──
// 8 of ~10 specs typed by hand + 2 persona Qs answered + 0 removed → a hands-on, spec-literate,
// decisive buyer. THIS is the signal we used to throw away (it only fired analytics counts).
const genset = distill({ specsFilledByUser: 8, specsAvailable: 10, specsOverridden: 0, specsRemoved: 0, personaQsAnswered: 2, personaQsSkipped: 0, deliveryTimeline: 'Immediate', paymentTerms: 'Full Advance' });
ok('diesel: spec_engagement = High (8/10 by hand)', genset.spec_engagement?.value === 'High');
ok('diesel: question_engagement = High (2 answered, 0 skipped)', genset.question_engagement?.value === 'High');
ok('diesel: urgency_posture = Immediate', genset.urgency_posture?.value === 'Immediate');
ok('diesel: commercial_posture = Advance-led', genset.commercial_posture?.value === 'Advance-led');
ok('diesel: no independence trait (0 overrides — accepted the 1 cascade spec)', !genset.independence);
ok('diesel: no flexibility trait (0 removed → no receipts → omitted)', !genset.flexibility);
ok('diesel: every emitted trait carries rfq_session evidence', [genset.spec_engagement, genset.urgency_posture, genset.commercial_posture].every((t) => t.evidence[0].source === 'rfq_session'));
ok('diesel: single-session confidence is capped (≤60)', [genset.spec_engagement, genset.urgency_posture].every((t) => t.confidence <= 60));

// ── spec_engagement matrix ──
ok('spec: delegating buyer (1/10 by hand) → Low', distill({ specsFilledByUser: 1, specsAvailable: 10, personaQsAnswered: 0, personaQsSkipped: 0 }).spec_engagement?.value === 'Low');
ok('spec: medium (3/10) → Medium', distill({ specsFilledByUser: 3, specsAvailable: 10, personaQsAnswered: 0, personaQsSkipped: 0 }).spec_engagement?.value === 'Medium');
ok('spec: 6+ by hand → High even if many available', distill({ specsFilledByUser: 6, specsAvailable: 20, personaQsAnswered: 0, personaQsSkipped: 0 }).spec_engagement?.value === 'High');
ok('spec: nothing filled, nothing answered → NO trait (no receipts)', !distill({ specsFilledByUser: 0, specsAvailable: 10, personaQsAnswered: 0, personaQsSkipped: 0 }).spec_engagement);

// ── flexibility (the × remove signal) ──
ok('flex: removed 2 → High', distill({ specsFilledByUser: 1, specsAvailable: 5, specsRemoved: 2, personaQsAnswered: 0, personaQsSkipped: 0 }).flexibility?.value === 'High');
ok('flex: removed 1 → Medium', distill({ specsFilledByUser: 1, specsAvailable: 5, specsRemoved: 1, personaQsAnswered: 0, personaQsSkipped: 0 }).flexibility?.value === 'Medium');
ok('flex: removed 0 → omitted', !distill({ specsFilledByUser: 1, specsAvailable: 5, specsRemoved: 0, personaQsAnswered: 0, personaQsSkipped: 0 }).flexibility);

// ── question_engagement (answer vs IGNORE the persona/why questions) ──
ok('Q: skipped, none answered → Low (transactional / ask less)', distill({ specsFilledByUser: 0, specsAvailable: 5, personaQsAnswered: 0, personaQsSkipped: 1 }).question_engagement?.value === 'Low');
ok('Q: 2 answered, 0 skipped → High (cooperative)', distill({ specsFilledByUser: 0, specsAvailable: 5, personaQsAnswered: 2, personaQsSkipped: 0 }).question_engagement?.value === 'High');
ok('Q: 1 answered → Medium', distill({ specsFilledByUser: 0, specsAvailable: 5, personaQsAnswered: 1, personaQsSkipped: 0 }).question_engagement?.value === 'Medium');

// ── urgency_posture (delivery-timeline enum → meaning; generic, not category) ──
ok('urgency: "Immediate" → Immediate', distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, deliveryTimeline: 'Immediate' }).urgency_posture?.value === 'Immediate');
ok('urgency: "Within 15 Days" → Planned', distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, deliveryTimeline: 'Within 15 Days' }).urgency_posture?.value === 'Planned');
ok('urgency: "Flexible" → Flexible', distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, deliveryTimeline: 'Flexible' }).urgency_posture?.value === 'Flexible');

// ── commercial_posture (payment-terms enum → meaning) ──
ok('payment: "Full Advance" → Advance-led', distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, paymentTerms: 'Full Advance' }).commercial_posture?.value === 'Advance-led');
ok('payment: "Credit (Post-Delivery)" → Credit-seeking', distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, paymentTerms: 'Credit (Post-Delivery)' }).commercial_posture?.value === 'Credit-seeking');
ok('payment: "COD" → COD', distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, paymentTerms: 'COD' }).commercial_posture?.value === 'COD');
ok('payment: "Loan/Finance" → Finance-seeking', distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, paymentTerms: 'Loan/Finance' }).commercial_posture?.value === 'Finance-seeking');

// ── independence (the "change specs" signal: OVERRODE an AI suggestion — keystroke-safe, deduped) ──
ok('independence: overrode 2 AI specs → High (strong own spec knowledge)', distill({ specsFilledByUser: 5, specsAvailable: 8, personaQsAnswered: 0, personaQsSkipped: 0, specsOverridden: 2 }).independence?.value === 'High');
ok('independence: overrode 1 → Medium', distill({ specsFilledByUser: 5, specsAvailable: 8, personaQsAnswered: 0, personaQsSkipped: 0, specsOverridden: 1 }).independence?.value === 'Medium');
ok('independence: overrode 0 → omitted (accepted, or no suggestion existed → ambiguous → no claim)', !distill({ specsFilledByUser: 5, specsAvailable: 8, personaQsAnswered: 0, personaQsSkipped: 0, specsOverridden: 0 }).independence);

// ── empty session → no traits, just the envelope (honest: no receipts ⇒ nothing claimed) ──
const empty = distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0 });
ok('empty: no traits emitted', !empty.spec_engagement && !empty.urgency_posture && !empty.commercial_posture && !empty.question_engagement);
ok('empty: still carries session_count=1', empty.session_count === 1);

// ── merge: the cross-session flywheel ──
const s1 = distill({ specsFilledByUser: 8, specsAvailable: 10, personaQsAnswered: 2, personaQsSkipped: 0, deliveryTimeline: 'Immediate', paymentTerms: 'Full Advance' });
const s2 = distill({ specsFilledByUser: 7, specsAvailable: 10, personaQsAnswered: 2, personaQsSkipped: 0, deliveryTimeline: 'Immediate', paymentTerms: 'Full Advance' });
const m = merge(s1, s2);
ok('merge: session_count grows (1+1 → 2)', m.session_count === 2);
ok('merge: same value seen twice → stability RISES (30 → 45)', m.spec_engagement.trait_stability === 45);
ok('merge: same value seen twice → confidence rises but capped (≤75)', m.spec_engagement.confidence > s1.spec_engagement.confidence && m.spec_engagement.confidence <= 75);
ok('merge: consistent value → no contradiction recorded', m.urgency_posture.contradictions_count === 0);
ok('merge: most-recent value wins', m.spec_engagement.value === 'High');

// merge with a CHANGED value → contradiction recorded, stability drops, recent value kept
const s3 = distill({ specsFilledByUser: 1, specsAvailable: 10, personaQsAnswered: 0, personaQsSkipped: 1, deliveryTimeline: 'Flexible' });
const m2 = merge(s1, s3);
ok('merge: changed urgency (Immediate→Flexible) → contradiction++', m2.urgency_posture.contradictions_count === 1);
ok('merge: changed value → stability DROPS', m2.urgency_posture.trait_stability < s1.urgency_posture.trait_stability);
ok('merge: changed value → most-recent (Flexible) kept', m2.urgency_posture.value === 'Flexible');

// merge carries forward a prior trait NOT re-observed this session (still behaviour we have)
const sOnlyPayment = distill({ specsFilledByUser: 0, specsAvailable: 0, personaQsAnswered: 0, personaQsSkipped: 0, paymentTerms: 'Full Advance' });
const mCarry = merge(s1, sOnlyPayment);
ok('merge: prior spec_engagement carried forward when not re-observed', mCarry.spec_engagement?.value === 'High');
ok('merge: no prior → returns current unchanged', merge(null, s1) === s1);

console.log(`\nbehaviortest (BTE-v1.3 observed in-session behaviour → traits + cross-session merge): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
