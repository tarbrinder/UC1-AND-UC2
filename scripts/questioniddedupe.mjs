// Deterministic test for PLANNER QUESTION ID DE-COLLISION — mirrors the de-collide pass in
// gemini.ts (planRequirement, after .slice(0,3)) and planToDynQuestions in RFQModalV3.tsx.
//
// THE BUG (live dry run, diesel generator): the registry showed BOTH
//   cadence = "One-time purchase" · Planner   AND   budget = "One-time purchase" · Planner
// i.e. the CADENCE answer bled into the BUDGET field. Root cause: the form keys its answer map
// (dynAnswers) by question id, and the planner LLM emitted the SAME id for the cadence card and
// the budget card. dynAnswers[sharedId] is therefore ONE slot — answering cadence makes the
// budget card read the same value. The fix de-collides ids so every card has a distinct, stable id.
// GENERIC · NO category literals · NO LLM.

// ── mirror of the OLD (buggy) id assignment: preserve the LLM id verbatim ──
const oldIds = (qs) => qs.map((q, i) => ({ ...q, id: q.id || `pq-${i}` }));

// ── mirror of the NEW de-collide (gemini.ts post-slice loop + planToDynQuestions boundary).
// Identical logic in both sites; only the fallback prefix differs (pq- vs plan-). ──
function decollide(qs, prefix = 'pq') {
  const seen = new Set();
  return qs.map((q, k) => {
    let id = (q.id || '').trim() || `${prefix}-${k}`;
    if (seen.has(id)) id = `${id}__${k}`; // collision → unique, stable suffix
    seen.add(id);
    return { ...q, id };
  });
}

// ── mirror of the registry recording (RFQModalV3.tsx:1781): cov.record(label→concept, dynAnswers[q.id]).
// Only the concept-normalization shape matters here (budget vs cadence map to different concepts). ──
const concept = (label) =>
  /budget|estimated? (cost|spend)|price\s*(band|range)/i.test(label) ? 'budget'
  : /how often|cadence|frequen|one-?time|repeat|re-?order/i.test(label) ? 'cadence'
  : label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function record(cards, dynAnswers) {
  const reg = {};
  for (const q of cards) { const a = (dynAnswers[q.id] || '').trim(); if (a) reg[concept(q.label)] = a; }
  return reg;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

// ── THE REPRO: planner LLM emits cadence + budget with the SAME id "purchase". ──
const llmCards = [
  { id: 'purchase', label: 'How often will you need to purchase generators?', tier: 'scale' },        // cadence
  { id: 'purchase', label: 'What is your estimated budget for this generator?', tier: 'constraint' }, // budget
];

// Buyer answers the CADENCE card (the first one). dynAnswers is keyed by THAT card's id.
const oldCards = oldIds(llmCards);
const newCards = decollide(llmCards);
const dynOld = { [oldCards[0].id]: 'One-time purchase' };
const dynNew = { [newCards[0].id]: 'One-time purchase' };
const regOld = record(oldCards, dynOld);
const regNew = record(newCards, dynNew);

// 1) Prove the bug reproduces with the OLD logic (so we know the harness models the real defect).
ok('OLD (buggy): the cadence answer bleeds into the budget field — registry.budget === "One-time purchase"', regOld.budget === 'One-time purchase');
ok('OLD (buggy): both concepts collapse to the single shared dynAnswers slot', regOld.budget === regOld.cadence);

// 2) Prove the fix: ids de-collided → distinct → no bleed.
ok('NEW: the two cards now have DISTINCT ids', newCards[0].id !== newCards[1].id);
ok('NEW: cadence is still recorded correctly', regNew.cadence === 'One-time purchase');
ok('NEW: budget is NOT polluted (the budget card was never answered → not recorded)', regNew.budget === undefined);

// 3) When the budget card IS answered, it keeps its OWN value (no cross-talk either direction).
const dynBoth = { [newCards[0].id]: 'One-time purchase', [newCards[1].id]: '₹2–5 lakh' };
const regBoth = record(newCards, dynBoth);
ok('NEW: independent slots — cadence="One-time purchase", budget="₹2–5 lakh"', regBoth.cadence === 'One-time purchase' && regBoth.budget === '₹2–5 lakh');

// ── STABILITY: non-colliding ids must be PRESERVED so answers persist across re-plans. ──
const distinct = [
  { id: 'cadence_q', label: 'How often will you purchase?' },
  { id: 'budget_q', label: 'What is your estimated budget?' },
  { id: 'install_q', label: 'Do you require installation support?' },
];
const stable = decollide(distinct);
ok('STABILITY: distinct LLM ids are preserved verbatim (answers survive re-plans)', stable.map((q) => q.id).join(',') === 'cadence_q,budget_q,install_q');

// ── FALLBACK: missing ids get unique positional ids. ──
const noIds = decollide([{ label: 'A' }, { label: 'B' }, { label: 'C' }]);
ok('FALLBACK: missing ids → unique pq-0/pq-1/pq-2', new Set(noIds.map((q) => q.id)).size === 3);

// ── N-WAY collision: three cards sharing one id all end up distinct. ──
const triple = decollide([{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }, { id: 'x', label: 'C' }]);
ok('N-WAY: three colliding ids → three distinct ids', new Set(triple.map((q) => q.id)).size === 3);
ok('N-WAY: the FIRST occurrence keeps the clean id (stable for the already-answered card)', triple[0].id === 'x');

// ── A provided id that happens to equal another card's positional fallback also de-collides. ──
const mixed = decollide([{ label: 'A' }, { id: 'pq-0', label: 'B' }]); // card0 → "pq-0"; card1 explicitly "pq-0"
ok('MIXED: explicit id colliding with a positional fallback is de-collided', mixed[0].id !== mixed[1].id);

// ── planToDynQuestions variant uses the "plan-" prefix; same guarantee. ──
const planVariant = decollide([{ id: 'dup', label: 'A' }, { id: 'dup', label: 'B' }], 'plan');
ok('planToDynQuestions variant ("plan-" prefix): colliding ids de-collide', planVariant[0].id !== planVariant[1].id);

console.log(`\nquestioniddedupe (planner id de-collision · budget←cadence bleed repro+fix · stability preserved · fallback ids · N-way · mixed-fallback · plan-variant): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
