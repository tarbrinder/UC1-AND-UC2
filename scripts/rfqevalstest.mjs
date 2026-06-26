// Deterministic test for RFQ EVALS — mirrors src/lib/rfqEvals.ts.
// Evals score "was this GOOD?" (quality), NOT "is it correct?" (regression — that's the harnesses).
// Modelled on the Diesel-Generator run (good) vs a degenerate RFQ (bad). NO LLM.

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function questionQualityEval(i) {
  const qs = i.questions || []; const cap = i.maxCards ?? 3;
  if (qs.length === 0) return { name: 'Question Quality', score: 100, max: 100, note: '0 cards' };
  const grounded = qs.filter((q) => q.grounded).length;
  const chipped = qs.filter((q) => q.optionCount >= 2).length;
  const specSet = new Set((i.specNames || []).map(norm));
  const redundant = qs.filter((q) => specSet.has(norm(q.label.replace(/\?$/, '')))).length;
  const score = Math.round((grounded / qs.length) * 40 + (chipped / qs.length) * 25 + (qs.length ? (1 - redundant / qs.length) * 20 : 20) + (qs.length <= cap ? 15 : clamp(15 - (qs.length - cap) * 5, 0, 15)));
  return { name: 'Question Quality', score: clamp(score), max: 100, note: '' };
}
function categoryQualityEval(s, band) { return { name: 'Category Quality', score: clamp(Math.round(s)), max: 100, note: band }; }
const GENERIC_INTENT = new Set(['retail', 'resale', 'industrial', 'project', 'maintenance', 'personal', 'unknown', 'general', 'generaluse', 'other', 'use', 'business', 'commercial', 'misc', 'packaging', 'supply', 'equipment']);
function intentQualityEval(i) {
  const cands = (i.candidates || []).slice().sort((a, b) => b.score - a.score); const top = cands[0];
  if (!i.chosen) return { name: 'Intent Quality', score: 100, max: 100, note: 'asked' };
  const isGeneric = GENERIC_INTENT.has(norm(i.chosen));
  const specScore = isGeneric ? 10 : 50;
  const margin = cands.length >= 2 ? clamp(cands[0].score - cands[1].score) : (top ? top.score : 50);
  const marginScore = clamp((margin / 40) * 30, 0, 30);
  const aligned = top ? (norm(i.chosen).includes(norm(top.label)) || norm(top.label).includes(norm(i.chosen))) : false;
  const alignScore = top ? (aligned ? 20 : 8) : 12;
  return { name: 'Intent Quality', score: clamp(Math.round(specScore + marginScore + alignScore)), max: 100, note: isGeneric ? 'generic' : 'specific' };
}
function fusionQualityEval(i) {
  const shouldFuse = i.band === 'rich' && i.buyerHasOperation;
  let score;
  if (shouldFuse && i.fusionFired) score = 100;
  else if (shouldFuse && !i.fusionFired) score = 60;
  else if (!shouldFuse && i.fusionFired) score = 20;
  else score = 100;
  return { name: 'Fusion Quality', score, max: 100, note: '' };
}
function plannerQualityEval(i) {
  const archetypeOk = !!i.archetype && i.archetype !== 'unknown';
  const grounded = i.questionCount === 0 ? true : i.groundedQuestions >= i.questionCount;
  const score = (archetypeOk ? 20 : 0) + (i.hasLead ? 20 : 0) + (i.mustHaveCount >= 1 ? 20 : 0) + (i.questionCount <= 3 ? 20 : 0) + (grounded ? 20 : 0);
  return { name: 'Planner Quality', score, max: 100, note: '' };
}
function rfqQualityEval(i) {
  const completeness = i.mustHaveTotal > 0 ? (i.mustHaveFilled / i.mustHaveTotal) * 35 : 35;
  const score = clamp(Math.round(completeness + (i.hasQuantity ? 10 : 0) + (i.hasIntent ? 15 : 0) + (i.hasLocation ? 10 : 0) + (i.identityVerified ? 15 : 0) + Math.max(0, 15 - i.openContradictions * 7.5)));
  return { name: 'RFQ Quality (proxy)', score, max: 100, note: '' };
}
function leadQualityEval(i) {
  const mat = /repeat/i.test(i.maturity) ? 20 : /existing/i.test(i.maturity) ? 16 : /new/i.test(i.maturity) ? 8 : 4;
  const score = clamp(Math.round((i.identityVerified ? 20 : 0) + (i.hasCompany ? 15 : 0) + (i.hasGST ? 15 : 0) + mat + (i.intentLocked ? 15 : 0) + (Math.min(Math.max(i.engagementSignals, 0), 10) / 10) * 15));
  return { name: 'Lead Quality (proxy)', score, max: 100, note: '' };
}
function outcomeEval(i) {
  const dr=(i.dealReadiness||'').toLowerCase();
  const rdy=/hot/.test(dr)?35:/warm/.test(dr)?25:/cold/.test(dr)?10:18;
  const score=clamp(Math.round(rdy+(i.rfqComplete?20:0)+(i.intentLocked?10:0)+(Math.min(Math.max(i.buyerEngagement,0),10)/10)*15-i.openBlockers*8+20));
  return {name:'Outcome (predicted, leading)',score,max:100,note:''};
}
function evaluateRFQ(dimensions) {
  const dims = dimensions.filter(Boolean);
  const max = dims.reduce((s, d) => s + d.max, 0) || 1;
  const score = dims.reduce((s, d) => s + d.score, 0);
  const pct = Math.round((score / max) * 100);
  const grade = pct >= 80 ? 'A' : pct >= 65 ? 'B' : pct >= 50 ? 'C' : 'D';
  const issues = dims.filter((d) => d.score < d.max * 0.7).map((d) => d.name);
  return { score, max, pct, grade, dimensions: dims, issues };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── HARNESS vs EVAL distinction is the whole point: same valid output can be correct yet low-quality ──

// GOOD RFQ (Diesel-like): rich category, 3 grounded chip questions (none re-asking a spec), fusion fired, clean planner
const goodQ = questionQualityEval({ questions: [{ label: 'What is your budget?', grounded: true, optionCount: 4 }, { label: 'Need installation?', grounded: true, optionCount: 3 }, { label: 'Repeat need?', grounded: true, optionCount: 2 }], specNames: ['Rated Power', 'Phase', 'Fuel Type'], maxCards: 3 });
ok('GOOD questions → high (≥90)', goodQ.score >= 90);
const goodEval = evaluateRFQ([goodQ, categoryQualityEval(90, 'rich'), fusionQualityEval({ band: 'rich', fusionFired: true, buyerHasOperation: true }), plannerQualityEval({ archetype: 'capital', hasLead: true, mustHaveCount: 3, questionCount: 3, groundedQuestions: 3 })]);
ok('GOOD RFQ → grade A', goodEval.grade === 'A');
ok('GOOD RFQ → no issues flagged', goodEval.issues.length === 0);

// BAD RFQ: ungrounded questions that re-ask specs, fused on an EMPTY category, planner with no lead/must-haves
const badQ = questionQualityEval({ questions: [{ label: 'Rated Power?', grounded: false, optionCount: 1 }, { label: 'Phase?', grounded: false, optionCount: 0 }, { label: 'Color?', grounded: false, optionCount: 2 }, { label: 'Brand?', grounded: false, optionCount: 2 }, { label: 'Size?', grounded: false, optionCount: 2 }], specNames: ['Rated Power', 'Phase'], maxCards: 3 });
ok('BAD questions → low (<50): ungrounded + redundant + over-cap', badQ.score < 50);
const badEval = evaluateRFQ([badQ, categoryQualityEval(0, 'empty'), fusionQualityEval({ band: 'empty', fusionFired: true, buyerHasOperation: true }), plannerQualityEval({ archetype: 'unknown', hasLead: false, mustHaveCount: 0, questionCount: 5, groundedQuestions: 0 })]);
ok('BAD RFQ → grade D', badEval.grade === 'D');
ok('BAD RFQ → multiple issues flagged', badEval.issues.length >= 3);

// ── FUSION QUALITY matrix (the gate correctness) ──
ok('fusion: rich + operation + fired = 100 (correct)', fusionQualityEval({ band: 'rich', fusionFired: true, buyerHasOperation: true }).score === 100);
ok('fusion: rich + operation + NOT fired = 60 (missed)', fusionQualityEval({ band: 'rich', fusionFired: false, buyerHasOperation: true }).score === 60);
ok('fusion: empty + fired = 20 (FALSE fusion — worst)', fusionQualityEval({ band: 'empty', fusionFired: true, buyerHasOperation: true }).score === 20);
ok('fusion: empty + NOT fired = 100 (correct restraint)', fusionQualityEval({ band: 'empty', fusionFired: false, buyerHasOperation: true }).score === 100);
ok('fusion: thin + fired = 20 (false fusion on weak data)', fusionQualityEval({ band: 'thin', fusionFired: true, buyerHasOperation: true }).score === 20);
ok('fusion: rich but NO operation + not fired = 100 (gate correctly not met)', fusionQualityEval({ band: 'rich', fusionFired: false, buyerHasOperation: false }).score === 100);

// ── known-buyer fast-track: 0 questions is GOOD, not a failure ──
ok('0 planner questions → Question Quality 100 (fast-track is good)', questionQualityEval({ questions: [], specNames: ['A'] }).score === 100);
ok('0 questions → planner grounded check passes', plannerQualityEval({ archetype: 'commodity', hasLead: true, mustHaveCount: 2, questionCount: 0, groundedQuestions: 0 }).score === 100);

// ── planner quality components ──
ok('planner missing lead + must-haves → ≤60', plannerQualityEval({ archetype: 'capital', hasLead: false, mustHaveCount: 0, questionCount: 2, groundedQuestions: 2 }).score <= 60);

// ── category quality maps confidence through ──
ok('category quality mirrors confidence (90 rich)', categoryQualityEval(90, 'rich').score === 90 && categoryQualityEval(0, 'empty').score === 0);

// ── overall: a rich category but BAD questions still drags the grade (no single dim dominates) ──
const mixed = evaluateRFQ([badQ, categoryQualityEval(90, 'rich'), fusionQualityEval({ band: 'rich', fusionFired: true, buyerHasOperation: true }), plannerQualityEval({ archetype: 'capital', hasLead: true, mustHaveCount: 2, questionCount: 5, groundedQuestions: 0 })]);
ok('mixed (rich category, bad questions) → not an A (quality is multi-dimensional)', mixed.grade !== 'A');

// ════ BUSINESS EVALS (proxy / leading indicators) ════
// RFQ Quality: complete + intent + location + verified + no conflicts → seller can quote cold
ok('RFQ Quality: full RFQ (specs done, intent, location, verified, 0 conflicts) → ≥90', rfqQualityEval({ mustHaveTotal: 3, mustHaveFilled: 3, hasQuantity: true, hasIntent: true, hasLocation: true, identityVerified: true, openContradictions: 0 }).score >= 90);
ok('RFQ Quality: half specs, no intent, unverified, 2 conflicts → low (<50)', rfqQualityEval({ mustHaveTotal: 4, mustHaveFilled: 1, hasQuantity: true, hasIntent: false, hasLocation: false, identityVerified: false, openContradictions: 2 }).score < 50);
ok('RFQ Quality: open conflicts erode the score', rfqQualityEval({ mustHaveTotal: 2, mustHaveFilled: 2, hasQuantity: true, hasIntent: true, hasLocation: true, identityVerified: true, openContradictions: 2 }).score < rfqQualityEval({ mustHaveTotal: 2, mustHaveFilled: 2, hasQuantity: true, hasIntent: true, hasLocation: true, identityVerified: true, openContradictions: 0 }).score);
ok('RFQ Quality: no must-haves defined → completeness not penalised', rfqQualityEval({ mustHaveTotal: 0, mustHaveFilled: 0, hasQuantity: true, hasIntent: true, hasLocation: true, identityVerified: true, openContradictions: 0 }).score >= 85);

// Lead Quality: verified repeat buyer with company+GST+intent+engagement → strong
ok('Lead Quality: verified repeat buyer + company + GST + engaged → ≥90', leadQualityEval({ identityVerified: true, hasCompany: true, hasGST: true, maturity: 'repeat', intentLocked: true, engagementSignals: 10 }).score >= 90);
ok('Lead Quality: anonymous new buyer, no company/GST/engagement → low (<35)', leadQualityEval({ identityVerified: false, hasCompany: false, hasGST: false, maturity: 'new', intentLocked: false, engagementSignals: 0 }).score < 35);
ok('Lead Quality: repeat outranks new (maturity weight)', leadQualityEval({ identityVerified: true, hasCompany: true, hasGST: false, maturity: 'repeat', intentLocked: true, engagementSignals: 5 }).score > leadQualityEval({ identityVerified: true, hasCompany: true, hasGST: false, maturity: 'new', intentLocked: true, engagementSignals: 5 }).score);
ok('Lead Quality: engagement signals lift the score', leadQualityEval({ identityVerified: true, hasCompany: true, hasGST: true, maturity: 'existing', intentLocked: true, engagementSignals: 10 }).score > leadQualityEval({ identityVerified: true, hasCompany: true, hasGST: true, maturity: 'existing', intentLocked: true, engagementSignals: 0 }).score);

// business evals compose into the same combiner (a separate "business" grouping)
const biz = evaluateRFQ([rfqQualityEval({ mustHaveTotal: 3, mustHaveFilled: 3, hasQuantity: true, hasIntent: true, hasLocation: true, identityVerified: true, openContradictions: 0 }), leadQualityEval({ identityVerified: true, hasCompany: true, hasGST: true, maturity: 'repeat', intentLocked: true, engagementSignals: 10 })]);
ok('business evals compose → grade A', biz.grade === 'A');

// ════ OUTCOME EVAL (grounded in deal_readiness — leading outcome) ════
ok('Outcome: HOT readiness + complete + engaged + no blockers → ≥90', outcomeEval({ dealReadiness: 'Hot', rfqComplete: true, openBlockers: 0, buyerEngagement: 10, intentLocked: true }).score >= 90);
ok('Outcome: COLD + incomplete + blocked → low (<35)', outcomeEval({ dealReadiness: 'Cold', rfqComplete: false, openBlockers: 2, buyerEngagement: 1, intentLocked: false }).score < 35);
ok('Outcome: HOT outranks WARM outranks COLD (readiness drives it)', outcomeEval({ dealReadiness: 'Hot', rfqComplete: true, openBlockers: 0, buyerEngagement: 5, intentLocked: true }).score > outcomeEval({ dealReadiness: 'Warm', rfqComplete: true, openBlockers: 0, buyerEngagement: 5, intentLocked: true }).score && outcomeEval({ dealReadiness: 'Warm', rfqComplete: true, openBlockers: 0, buyerEngagement: 5, intentLocked: true }).score > outcomeEval({ dealReadiness: 'Cold', rfqComplete: true, openBlockers: 0, buyerEngagement: 5, intentLocked: true }).score);
ok('Outcome: open blockers erode the prediction', outcomeEval({ dealReadiness: 'Warm', rfqComplete: true, openBlockers: 3, buyerEngagement: 5, intentLocked: true }).score < outcomeEval({ dealReadiness: 'Warm', rfqComplete: true, openBlockers: 0, buyerEngagement: 5, intentLocked: true }).score);
ok('Outcome: unknown readiness → neutral (not zero, not high)', (() => { const s = outcomeEval({ dealReadiness: '', rfqComplete: true, openBlockers: 0, buyerEngagement: 5, intentLocked: true }).score; return s > 40 && s < 80; })());

// ════ INTENT QUALITY (consumes deriveIntent scored intent_candidates) ════
ok('Intent: specific winner + clear margin + aligned → ≥90', intentQualityEval({ chosen: 'Manufacturing backup', candidates: [{ label: 'Manufacturing backup', score: 92 }, { label: 'Commercial backup', score: 55 }, { label: 'Residential', score: 12 }] }).score >= 90);
ok('Intent: generic/journey-word winner ("industrial") → low (<55)', intentQualityEval({ chosen: 'industrial', candidates: [{ label: 'industrial', score: 95 }, { label: 'maintenance', score: 70 }] }).score < 55);
ok('Intent: thin margin scores below a clear margin', intentQualityEval({ chosen: 'Factory backup', candidates: [{ label: 'Factory backup', score: 80 }, { label: 'Office backup', score: 78 }] }).score < intentQualityEval({ chosen: 'Factory backup', candidates: [{ label: 'Factory backup', score: 90 }, { label: 'Office backup', score: 40 }] }).score);
ok('Intent: chosen ≠ top candidate dings alignment', intentQualityEval({ chosen: 'Office backup', candidates: [{ label: 'Factory backup', score: 90 }, { label: 'Office backup', score: 55 }] }).score < intentQualityEval({ chosen: 'Factory backup', candidates: [{ label: 'Factory backup', score: 90 }, { label: 'Office backup', score: 55 }] }).score);
ok('Intent: null chosen (asked the buyer) → neutral-high, not a failure', intentQualityEval({ chosen: null, candidates: [{ label: 'X', score: 60 }] }).score === 100);
ok('Intent: specific chosen with no candidates still scores on specificity (≥60)', intentQualityEval({ chosen: 'Notebook packaging', candidates: [] }).score >= 60);

// ── graceful ──
ok('empty dimensions → no divide-by-zero', evaluateRFQ([]).pct === 0);
ok('Intent: empty input graceful', intentQualityEval({ chosen: null, candidates: [] }).score === 100);

console.log(`\nrfqevalstest (Evals = quality not regression · question/category/fusion/planner dims · fusion-gate matrix · fast-track-is-good · multi-dimensional grade · graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
