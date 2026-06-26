// Deterministic test for the RFQ DECISION AUDIT / SCORECARD — mirrors src/lib/rfqScorecard.ts.
// The "measure" half: prove the scorecard rewards UTILIZATION (knows more, asks less), reuse, and
// catching contradictions — and that it degrades sanely. Modelled on Amit (GLID 68151813). NO LLM.

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);
function scoreRFQ(input) {
  const factsAvailable = Math.max(0, input.factsAvailable);
  const factsUsed = clamp(input.factsUsed, 0, factsAvailable);
  const factsIgnored = Math.max(0, factsAvailable - factsUsed);
  const utilizationPct = pct(factsUsed, factsAvailable);
  let confidence = 40;
  confidence += (utilizationPct / 100) * 30;
  confidence += (Math.min(input.questionsAvoided, 8) / 8) * 15;
  if (input.buyerIntelUsed) confidence += 4;
  if (input.prevRequirementReused) confidence += 5;
  if (input.locationPreferenceReused) confidence += 4;
  if (input.categoryIntelUsed) confidence += 5;
  if (input.conversationalSignalsUsed > 0) confidence += Math.min(input.conversationalSignalsUsed, 3);
  confidence -= input.contradictions * 6;
  confidence = clamp(Math.round(confidence));
  const grade = confidence >= 80 ? 'A' : confidence >= 65 ? 'B' : confidence >= 50 ? 'C' : 'D';
  return { ...input, factsUsed, factsIgnored, utilizationPct, confidence, grade };
}
// A2 — the honest utilization tally (mirror of tallyUtilization).
function tallyUtilization(p) {
  const used = Math.max(0, p.questionsAvoided) + Math.max(0, p.conversationalSignalsUsed)
    + Math.max(0, p.categoryCriticalsUsed) + Math.max(0, p.categoryEnhancers)
    + Math.max(0, p.intentUsed) + Math.max(0, p.personaUsed);
  const knowable = Math.max(0, p.registryFacts) + Math.max(0, p.conversationalAvailable)
    + Math.max(0, p.isqSpecs) + Math.max(0, p.categoryCriticalsUsed) + Math.max(0, p.categoryEnhancers);
  return { factsUsed: used, factsAvailable: Math.max(used, knowable) };
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── Amit-like rich RFQ: lots known, much used, reuse everywhere ──
const amit = scoreRFQ({ factsAvailable: 9, factsUsed: 6, questionsAsked: 3, questionsAvoided: 5, autoFilled: 3, contradictions: 0, locationPreferenceReused: true, prevRequirementReused: true, categoryIntelUsed: false, buyerIntelUsed: true, conversationalSignalsUsed: 4 });
ok('Amit: factsIgnored = 9-6 = 3', amit.factsIgnored === 3);
ok('Amit: utilization = 67%', amit.utilizationPct === 67);
ok('Amit: confidence is solid (>=70) even WITHOUT category intel', amit.confidence >= 70);
ok('Amit: location + prev-requirement reuse both counted', amit.locationPreferenceReused && amit.prevRequirementReused);

// ── UTILIZATION beats VOLUME: knows 6/use 6 > knows 50/use 3 (the core thesis) ──
const lean = scoreRFQ({ factsAvailable: 6, factsUsed: 6, questionsAsked: 2, questionsAvoided: 6, autoFilled: 2, contradictions: 0, locationPreferenceReused: true, prevRequirementReused: true, categoryIntelUsed: true, buyerIntelUsed: true, conversationalSignalsUsed: 3 });
const hoard = scoreRFQ({ factsAvailable: 50, factsUsed: 3, questionsAsked: 9, questionsAvoided: 1, autoFilled: 0, contradictions: 0, locationPreferenceReused: false, prevRequirementReused: false, categoryIntelUsed: false, buyerIntelUsed: true, conversationalSignalsUsed: 0 });
ok('THESIS: high utilization (6/6) scores higher than hoarding (3/50)', lean.confidence > hoard.confidence);
ok('lean uses 100% of facts', lean.utilizationPct === 100);
ok('hoard utilization is low (6%)', hoard.utilizationPct === 6);

// ── asking LESS raises confidence ──
const asksLess = scoreRFQ({ factsAvailable: 8, factsUsed: 6, questionsAsked: 1, questionsAvoided: 7, autoFilled: 4, contradictions: 0, locationPreferenceReused: true, prevRequirementReused: true, categoryIntelUsed: true, buyerIntelUsed: true, conversationalSignalsUsed: 3 });
const asksMore = scoreRFQ({ factsAvailable: 8, factsUsed: 6, questionsAsked: 7, questionsAvoided: 1, autoFilled: 4, contradictions: 0, locationPreferenceReused: true, prevRequirementReused: true, categoryIntelUsed: true, buyerIntelUsed: true, conversationalSignalsUsed: 3 });
ok('asking less (7 avoided) beats asking more (1 avoided)', asksLess.confidence > asksMore.confidence);
ok('asksLess earns an A', asksLess.grade === 'A');

// ── contradictions erode confidence (caught, but a flag for the seller) ──
const clean = scoreRFQ({ factsAvailable: 8, factsUsed: 6, questionsAsked: 3, questionsAvoided: 5, autoFilled: 2, contradictions: 0, locationPreferenceReused: true, prevRequirementReused: true, categoryIntelUsed: true, buyerIntelUsed: true, conversationalSignalsUsed: 2 });
const conflicted = scoreRFQ({ ...clean, contradictions: 3 });
ok('3 contradictions lower confidence by ~18', clean.confidence - conflicted.confidence === 18);

// ── category intel adds, but is NOT required to be usable (ChatGPT: last 20-30%) ──
const noCat = scoreRFQ({ factsAvailable: 9, factsUsed: 6, questionsAsked: 3, questionsAvoided: 5, autoFilled: 3, contradictions: 0, locationPreferenceReused: true, prevRequirementReused: true, categoryIntelUsed: false, buyerIntelUsed: true, conversationalSignalsUsed: 4 });
const withCat = scoreRFQ({ ...noCat, categoryIntelUsed: true });
ok('category intel adds exactly +5', withCat.confidence - noCat.confidence === 5);
ok('STILL usable without category (grade C or better)', ['A', 'B', 'C'].includes(noCat.grade));

// ── cold start: nothing known → low confidence, graceful ──
const cold = scoreRFQ({ factsAvailable: 0, factsUsed: 0, questionsAsked: 6, questionsAvoided: 0, autoFilled: 0, contradictions: 0, locationPreferenceReused: false, prevRequirementReused: false, categoryIntelUsed: false, buyerIntelUsed: false, conversationalSignalsUsed: 0 });
ok('cold start: utilization 0%, no divide-by-zero', cold.utilizationPct === 0);
ok('cold start: confidence is low (D)', cold.grade === 'D' && cold.confidence === 40);
ok('cold start: factsIgnored = 0 (none to ignore)', cold.factsIgnored === 0);

// ── clamps ──
ok('factsUsed never exceeds factsAvailable', scoreRFQ({ factsAvailable: 3, factsUsed: 99, questionsAsked: 0, questionsAvoided: 0, autoFilled: 0, contradictions: 0, locationPreferenceReused: false, prevRequirementReused: false, categoryIntelUsed: false, buyerIntelUsed: false, conversationalSignalsUsed: 0 }).factsUsed === 3);
ok('confidence clamps to 0-100', scoreRFQ({ factsAvailable: 1, factsUsed: 0, questionsAsked: 0, questionsAvoided: 0, autoFilled: 0, contradictions: 99, locationPreferenceReused: false, prevRequirementReused: false, categoryIntelUsed: false, buyerIntelUsed: false, conversationalSignalsUsed: 0 }).confidence === 0);

// ════ A2 HONESTY: tallyUtilization counts ALL consumption, not just avoided questions ════
// The diesel-generator run: questionsAvoided=2 but category(12 criticals + bands + 2 blockers),
// conv(6), intent(1), persona(1) ALL fired. The old "factsUsed = questionsAvoided" reported 2/44.
const dg = tallyUtilization({ questionsAvoided: 2, conversationalSignalsUsed: 6, categoryCriticalsUsed: 12, categoryEnhancers: 3, intentUsed: 1, personaUsed: 1, registryFacts: 28, conversationalAvailable: 6, isqSpecs: 10 });
ok('A2: diesel-gen factsUsed = 2+6+12+3+1+1 = 25 (NOT the old "2")', dg.factsUsed === 25);
ok('A2: knowable grows with category → factsAvailable = max(25, 28+6+10+12+3=59) = 59', dg.factsAvailable === 59);
ok('A2: the old undercount (avoided-only) was 2 — honest tally is >10× higher', dg.factsUsed > 10 * 2);
const dgScore = scoreRFQ({ ...dg, questionsAsked: 10, questionsAvoided: 2, autoFilled: 2, contradictions: 0, locationPreferenceReused: false, prevRequirementReused: true, categoryIntelUsed: true, buyerIntelUsed: true, conversationalSignalsUsed: 6 });
ok('A2: honest tally lifts the run off the false "2/44" floor (utilization ~42%, was ~5%)', dgScore.utilizationPct >= 40 && dgScore.utilizationPct <= 45);

// category COLD → no category contribution to either side
const ncTally = tallyUtilization({ questionsAvoided: 3, conversationalSignalsUsed: 2, categoryCriticalsUsed: 0, categoryEnhancers: 0, intentUsed: 1, personaUsed: 1, registryFacts: 20, conversationalAvailable: 2, isqSpecs: 8 });
ok('A2: category cold → counts only avoided+conv+intent+persona (3+2+0+0+1+1=7)', ncTally.factsUsed === 7);
ok('A2: factsUsed never exceeds factsAvailable', ncTally.factsUsed <= ncTally.factsAvailable);
ok('A2: all-zero → 0/0 graceful (no divide-by-zero downstream)', (() => { const t = tallyUtilization({ questionsAvoided: 0, conversationalSignalsUsed: 0, categoryCriticalsUsed: 0, categoryEnhancers: 0, intentUsed: 0, personaUsed: 0, registryFacts: 0, conversationalAvailable: 0, isqSpecs: 0 }); return t.factsUsed === 0 && t.factsAvailable === 0; })());
ok('A2: used > knowable base → factsAvailable bumps to used (utilization caps at 100%, never >)', (() => { const t = tallyUtilization({ questionsAvoided: 50, conversationalSignalsUsed: 0, categoryCriticalsUsed: 0, categoryEnhancers: 0, intentUsed: 0, personaUsed: 0, registryFacts: 1, conversationalAvailable: 0, isqSpecs: 0 }); return t.factsAvailable === t.factsUsed && pct(t.factsUsed, t.factsAvailable) === 100; })());
ok('A2: negative inputs floored at 0 (defensive)', tallyUtilization({ questionsAvoided: -5, conversationalSignalsUsed: 3, categoryCriticalsUsed: 0, categoryEnhancers: 0, intentUsed: 0, personaUsed: 0, registryFacts: 0, conversationalAvailable: 3, isqSpecs: 0 }).factsUsed === 3);

console.log(`\nscorecardtest (RFQ Decision Audit · utilization>volume · ask-less rewarded · conflicts erode · category=enhancer-not-gate · A2 honest tally · cold-start graceful): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
