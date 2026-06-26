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

// ── P1.2: FACT-UPGRADE / corroboration loop (mirror coverage.record() lifecycle) ──
// A Twin guess prefills (never suppresses); a buyer's own answer or a Verified fact stating the SAME
// value graduates it Observed/Likely → Confirmed; a DIFFERENT higher-authority answer overrides it.
const AUTH = { User: 100, LastPage: 95, Intent: 92, Spec: 85, Verified: 78, History: 75, Planner: 70, Cascade: 55, Enrichment: 52, Twin: 50, Deduced: 40 };
function record(store, concept, value, source) {
  const v = String(value).trim().toLowerCase();
  const prior = store.find((x) => x.concept === concept && (x.status === 'active' || x.status === 'confirmed'));
  if (prior) {
    if (prior.value.toLowerCase() === v) { if (source !== prior.source && AUTH[source] >= AUTH[prior.source]) prior.status = 'confirmed'; return; }
    if (AUTH[source] >= AUTH[prior.source]) prior.status = 'overridden';
    else { store.push({ concept, value, source, status: 'rejected' }); return; }
  }
  store.push({ concept, value, source, status: 'active' });
}
const activeOf = (store, c) => store.find((x) => x.concept === c && (x.status === 'active' || x.status === 'confirmed'));

// the named scenario: Twin guesses "Manufacturer", buyer confirms the SAME → Observed→Confirmed
let s1 = []; record(s1, 'buyer_type', 'Manufacturer', 'Twin'); record(s1, 'buyer_type', 'Manufacturer', 'User');
ok('corroboration: Twin "Manufacturer" + buyer confirms same → CONFIRMED', activeOf(s1, 'buyer_type').status === 'confirmed');
ok('corroboration: confirmed fact keeps the winning value', activeOf(s1, 'buyer_type').value === 'Manufacturer');

// buyer CORRECTS the Twin guess → buyer answer wins, Twin overridden
let s2 = []; record(s2, 'buyer_type', 'Manufacturer', 'Twin'); record(s2, 'buyer_type', 'Trader', 'User');
ok('override: buyer "Trader" beats Twin "Manufacturer" (buyer corrects the guess)', activeOf(s2, 'buyer_type').value === 'Trader' && activeOf(s2, 'buyer_type').source === 'User');

// a Verified business fact also corroborates a Twin guess
let s3 = []; record(s3, 'cross:company', 'Acme Pvt Ltd', 'Twin'); record(s3, 'cross:company', 'Acme Pvt Ltd', 'Verified');
ok('corroboration: Twin + Verified same value → CONFIRMED', activeOf(s3, 'cross:company').status === 'confirmed');

// a lower-authority source can NEVER override a buyer answer (stays rejected, debug trail)
let s4 = []; record(s4, 'buyer_type', 'Trader', 'User'); record(s4, 'buyer_type', 'Manufacturer', 'Twin');
ok('guard: Twin cannot override a User answer (kept as rejected trail)', activeOf(s4, 'buyer_type').value === 'Trader' && s4.some((x) => x.status === 'rejected'));

// the Twin role fact, recorded as source 'Twin', still does NOT suppress the buyer-type question
ok('the recorded Twin buyer-role fact does NOT hide the buyer-type question', coverHides(f('Twin', 50, 'Buyer type'), 'Which best describes you?') === false);

// ── P1.4: explicit_negative_signals → never re-suggest (mirror parseNegativeBans / violatesNegativeBan) ──
function parseNegativeBans(signals) {
  const bans = [];
  for (const s of signals || []) {
    const m = String(s).toLowerCase().match(/\b(?:no|not|never|avoid|without|don'?t|dont|except)\s+([a-z][a-z0-9 -]{2,40})/);
    if (m) { const phrase = m[1].replace(/\b(please|thanks?|suppliers?|sellers?|vendors?|me|us)\b/g, ' ').replace(/\s+/g, ' ').trim(); if (phrase.length >= 3) bans.push(phrase); }
  }
  return bans;
}
function violatesNegativeBan(text, bans) {
  const t = (text || '').toLowerCase();
  return bans.some((b) => { const tok = b.split(/\s+/).find((w) => w.length >= 4) || (b.length >= 4 ? b : ''); return !!tok && t.includes(tok); });
}
const BANS = parseNegativeBans(['No plastic', 'OEM only', "Don't call me", 'Avoid Chinese imports']);
ok('NS: "No plastic" → banned phrase parsed', BANS.includes('plastic'));
ok('NS: "Avoid Chinese imports" → banned phrase parsed', BANS.some((b) => b.includes('chinese')));
ok('NS: "OEM only" (inclusion, not a "no X") → NOT parsed as a ban (left to the prompt)', !BANS.some((b) => b.includes('oem')));
ok('NS: spec Material=Plastic is BLOCKED from auto-suggest', violatesNegativeBan('Material Plastic', BANS) === true);
ok('NS: spec Material=Steel is ALLOWED (not rejected)', violatesNegativeBan('Material Steel', BANS) === false);
ok('NS: Origin=Chinese is BLOCKED', violatesNegativeBan('Origin Chinese', BANS) === true);
ok('NS: empty constraints → nothing banned (no over-block)', parseNegativeBans([]).length === 0 && violatesNegativeBan('Material Plastic', []) === false);
ok('NS: bare "no" with nothing after → not parsed (no spurious ban)', parseNegativeBans(['no']).length === 0);

console.log(`\nsuppressiontest (only explicit sources hide questions; inferred prefill-only; P1.4 negative-signal gate): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
