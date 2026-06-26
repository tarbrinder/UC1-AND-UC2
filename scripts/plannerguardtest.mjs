// Deterministic test for the planner question backstops (A0 relevance + A1 grounding).
// Mirrors the parse-time filters in gemini.ts planRequirement — no LLM, no network.

const PLAN_ARCHETYPES = ['commodity', 'branded_commodity', 'capital', 'made_to_spec', 'project_service', 'visual_odd_part', 'unknown'];

// Mirror of the parse-time guards.
function keepQuestion(q, ctx) {
  const archetype = PLAN_ARCHETYPES.includes(ctx.archetype) ? ctx.archetype : 'unknown';
  const qtyN = Number(ctx.quantity) || 0;
  const discreteUnit = /piece|pcs|\bnos?\b|\bunit\b|\bset\b|pair|item|each/i.test(ctx.unit || '');
  const tinyCommodityOrder = qtyN > 0 && qtyN <= 10 && discreteUnit && (archetype === 'commodity' || archetype === 'branded_commodity');
  const isBudgetQ = /budget|₹|price\s*(band|range)|spend/i.test(`${q.label} ${(q.options || []).join(' ')}`);
  const intentAlreadyAsked = /stated purpose/i.test(ctx.application || ''); // T5: page-1 intent answered
  // A1 grounding: drop if NO groundedIn AND NO reason.
  if (!(q.groundedIn || q.reason)) return false;
  // A0 relevance: drop a budget question on a tiny commodity order.
  if (tinyCommodityOrder && isBudgetQ) return false;
  // T5: drop a tier:intent (purpose/use) question once the page-1 intent already captured it.
  if (intentAlreadyAsked && q.tier === 'intent') return false;
  return true;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n); } };

const budgetQ = { label: 'What is your approximate budget for this requirement?', options: ['Under ₹50,000', '₹50,000–₹2 lakh', '₹2–10 lakh', '₹10 lakh+'], groundedIn: 'order value', tier: 'scale' };
const cadenceQ = { label: 'How often will you buy this?', options: ['One-time', 'Monthly', 'Quarterly'], groundedIn: 'category is a consumable', tier: 'scale' };

// A0 — the cable-lug case: tiny commodity order → budget question DROPPED.
ok('A0 cable lug (qty 1, piece, commodity) → budget DROPPED', keepQuestion(budgetQ, { archetype: 'commodity', quantity: '1', unit: 'piece' }) === false);
ok('A0 cable lug → cadence still KEPT (relevant even at qty 1)', keepQuestion(cadenceQ, { archetype: 'commodity', quantity: '1', unit: 'piece' }) === true);
ok('A0 bulk order (qty 500, piece, commodity) → budget KEPT', keepQuestion(budgetQ, { archetype: 'commodity', quantity: '500', unit: 'piece' }) === true);
ok('A0 capital (qty 1, unit, capital) → budget KEPT (not a commodity)', keepQuestion(budgetQ, { archetype: 'capital', quantity: '1', unit: 'unit' }) === true);
ok('A0 bulk unit (qty 1, KG) → budget KEPT (non-discrete → LLM sizes it)', keepQuestion(budgetQ, { archetype: 'commodity', quantity: '1', unit: 'KG' }) === true);
ok('A0 qty 10 piece commodity → budget DROPPED (boundary)', keepQuestion(budgetQ, { archetype: 'commodity', quantity: '10', unit: 'piece' }) === false);
ok('A0 qty 11 piece commodity → budget KEPT (over threshold)', keepQuestion(budgetQ, { archetype: 'commodity', quantity: '11', unit: 'piece' }) === true);

// A1 — grounding enforcement.
ok('A1 ungrounded question (no groundedIn, no reason) → DROPPED', keepQuestion({ label: 'Any preference?', options: ['A', 'B'] }, { archetype: 'commodity', quantity: '500', unit: 'piece' }) === false);
ok('A1 grounded question → KEPT', keepQuestion({ label: 'Indoor or outdoor install?', options: ['Indoor', 'Outdoor'], groundedIn: 'category installs on site' }, { archetype: 'capital', quantity: '1', unit: 'unit' }) === true);
ok('A1 reason-only (soft fallback, no LLM groundedIn) → KEPT', keepQuestion({ label: 'New or replacement?', options: ['New', 'Replacement'], reason: 'shapes spec set' }, { archetype: 'capital', quantity: '1', unit: 'unit' }) === true);

// T5 — duplicate intent question. The planner re-asked "What type of construction is this for?"
// (tier:intent) after the page-1 intent. Drop it once the application carries a stated purpose.
const intentDupQ = { label: 'What type of construction is this for?', options: ['Residential', 'Commercial', 'Industrial'], tier: 'intent', groundedIn: 'category' };
const scaleQ = { label: 'How often will you buy?', options: ['One-time', 'Monthly'], tier: 'scale', groundedIn: 'consumable' };
ok('T5 tier:intent dup DROPPED when page-1 intent answered', keepQuestion(intentDupQ, { archetype: 'commodity', quantity: '5', unit: 'Tonne', application: "Buyer's stated purpose: project = Residential building." }) === false);
ok('T5 tier:intent KEPT when intent NOT yet answered (no stated purpose)', keepQuestion(intentDupQ, { archetype: 'commodity', quantity: '5', unit: 'Tonne', application: '' }) === true);
ok('T5 scale question KEPT even when intent answered (only intent-tier dropped)', keepQuestion(scaleQ, { archetype: 'commodity', quantity: '500', unit: 'Tonne', application: "Buyer's stated purpose: x = y." }) === true);

// P1.3 — explicit_unknowns prioritisation. buildTwinPlanInput drops unknowns we've ALREADY learned this
// session (covered in the registry) before they reach the planner, so the scarce question slots target
// only the genuinely-open unknowns. Mirror that filter.
const filterUnknowns = (unknowns, isCovered) => (unknowns || []).filter((u) => !(isCovered && isCovered(u)));
const COVERED = new Set(['budget']); // e.g. budget already answered via a deduced/last-page fact
const isCov = (u) => COVERED.has(u);
ok('U: an already-covered unknown (budget) is dropped before the planner', !filterUnknowns(['budget', 'cadence', 'install location'], isCov).includes('budget'));
ok('U: genuinely-open unknowns survive the filter', (() => { const r = filterUnknowns(['budget', 'cadence', 'install location'], isCov); return r.includes('cadence') && r.includes('install location'); })());
ok('U: no coverage predicate → all unknowns pass through (planner still prioritises)', filterUnknowns(['budget', 'cadence'], undefined).length === 2);
ok('U: empty unknowns → empty (no crash)', filterUnknowns([], isCov).length === 0);
ok('U: all covered → planner gets none (a fully-known buyer asks nothing extra)', filterUnknowns(['budget'], isCov).length === 0);

console.log(`\nplannerguardtest (A0 relevance + A1 grounding + T5 intent-dup + U: unknowns prioritisation): ${pass}/${pass + fail} passed${fail ? ` — ${fail} FAILED` : ' ✓'}`);
process.exit(fail ? 1 : 0);
