// Deterministic test for the QUESTION-SUPPRESSION POLICY (pilot audit, #1 over-personalisation guard).
// Mirrors RFQModalV3.tsx coverHides() (panel/planner questions) + coveredByQuestion() (specs).
// The contract: only EXPLICIT current-session sources hide a question; INFERRED / standing-pattern
// sources (Twin, History, Cascade, Verified, Enrichment, Deduced) may prefill/shape but NEVER hide.

// ── coverHides mirror: panel/planner question suppression ──
const COVER_HIDE_SOURCES = ['User', 'LastPage', 'Intent', 'Spec', 'Planner'];
function coverHides(fact, label) {
  if (!fact || fact.rawKey === label) return false; // self-hide guard
  return COVER_HIDE_SOURCES.includes(fact.source);
}
// ── coveredByQuestion mirror: spec (A5b) suppression — even stricter ──
function coveredByQuestion(fact) {
  return !!fact && (fact.source === 'Intent' || fact.source === 'Planner' || fact.source === 'LastPage');
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };
const f = (source, confidence = 90, rawKey = 'someFact') => ({ source, confidence, rawKey });

// EXPLICIT sources → CAN hide a panel question
['User', 'LastPage', 'Intent', 'Spec', 'Planner'].forEach((s) =>
  ok(`${s} CAN suppress a panel question`, coverHides(f(s), 'How often?') === true));

// INFERRED / standing-pattern sources → must NEVER hide a panel question alone
['Twin', 'History', 'Cascade', 'Verified', 'Enrichment', 'Deduced'].forEach((s) =>
  ok(`${s} must NOT suppress a panel question (prefill/shape only)`, coverHides(f(s, 95), 'How often?') === false));

// The exact audit scenario: a History "monthly" cadence fact must NOT hide the cadence question.
ok('History cadence=monthly does NOT hide the cadence question (buyer may have changed)', coverHides(f('History', 90, 'cadence'), 'How often will you reorder?') === false);
// A high-confidence Deduced commercial fact also must NOT silently suppress now (recovery gap fix).
ok('Deduced budget @92 does NOT silently hide the budget question', coverHides(f('Deduced', 92, 'budget'), 'Approximate budget?') === false);

// self-hide guard: an answered question's OWN fact never hides itself
ok('self-hide guard: a fact whose rawKey IS the label does not hide it', coverHides({ source: 'User', confidence: 100, rawKey: 'How often?' }, 'How often?') === false);
ok('no fact → not hidden', coverHides(null, 'How often?') === false);

// Spec (A5b) suppression is the stricter subset — only the 3 question-tier sources
ok('spec hidden by Intent', coveredByQuestion(f('Intent')) === true);
ok('spec hidden by Planner', coveredByQuestion(f('Planner')) === true);
ok('spec hidden by LastPage', coveredByQuestion(f('LastPage')) === true);
ok('spec NOT hidden by Spec source (a sibling spec never hides another)', coveredByQuestion(f('Spec')) === false);
ok('spec NOT hidden by Cascade', coveredByQuestion(f('Cascade')) === false);
ok('spec NOT hidden by History', coveredByQuestion(f('History')) === false);
ok('spec NOT hidden by Deduced', coveredByQuestion(f('Deduced')) === false);

console.log(`\nsuppressiontest (only explicit sources hide questions; inferred prefill-only): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
